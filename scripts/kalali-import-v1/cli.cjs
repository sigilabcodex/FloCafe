#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');

function validate(manifest) {
  const errors = [];
  const pending = [];
  const allowed = new Set(['confirmed', 'provisional', 'pending', 'historical', 'approved']);
  const scopes = ['categories', 'supplies', 'preparations', 'products', 'modifiers'];
  const scoped = new Set();
  for (const scope of scopes) {
    if (!Array.isArray(manifest[scope])) {
      errors.push(`${scope}: se esperaba una lista`);
      continue;
    }
    for (const row of manifest[scope]) {
      const key = `${scope}:${row.external_id}`;
      if (!row.external_id || scoped.has(key))
        errors.push(`${scope}: external_id vacío o duplicado (${row.external_id || '?'})`);
      scoped.add(key);
      if (!allowed.has(row.source_status))
        errors.push(`${row.external_id}: source_status inválido`);
    }
  }
  const supply = new Map(manifest.supplies.map((x) => [x.external_id, x]));
  const categories = new Set(manifest.categories.map((x) => x.external_id));
  const productIds = new Set(manifest.products.map((x) => x.external_id));
  for (const prep of manifest.preparations) {
    if (!supply.has(prep.output_supply_id)) errors.push(`${prep.external_id}: salida inexistente`);
    if (!Number.isFinite(prep.yield_quantity) || !prep.components?.length)
      pending.push(`${prep.external_id}: rendimiento/componentes pendientes`);
    for (const component of prep.components || []) {
      if (!supply.has(component.supply_id))
        errors.push(`${prep.external_id}: componente ${component.supply_id} inexistente`);
      if (
        !Number.isFinite(component.quantity) ||
        component.quantity <= 0 ||
        component.source_status === 'pending'
      )
        pending.push(`${prep.external_id}: componente/cantidad pendiente`);
    }
  }
  let completeRecipes = 0;
  for (const product of manifest.products) {
    if (!categories.has(product.category_id))
      errors.push(`${product.external_id}: categoría inexistente`);
    const items = product.recipe?.components || [];
    const complete =
      items.length > 0 &&
      items.every(
        (item) =>
          supply.has(item.supply_id) &&
          Number.isFinite(item.quantity) &&
          item.quantity > 0 &&
          item.source_status !== 'pending',
      );
    if (complete) completeRecipes++;
    else pending.push(`${product.external_id}: receta incompleta; se conserva pendiente`);
    if (product.pilot_status === 'pending')
      pending.push(`${product.external_id}: producto pendiente`);
    for (const candidate of Object.values(product.sale_price_candidates || {})) {
      if (!Number.isFinite(candidate.amount) || candidate.amount <= 0)
        errors.push(`${product.external_id}: precio candidato inválido`);
      if (candidate.status === 'approved')
        pending.push(
          `${product.external_id}: no se importa estado approved desde precio candidato`,
        );
    }
  }
  for (const modifier of manifest.modifiers) {
    for (const productId of modifier.applicable_to || [])
      if (!productIds.has(productId))
        errors.push(`${modifier.external_id}: producto relacionado inexistente ${productId}`);
    if (!Number.isFinite(modifier.quantity) || !Number.isFinite(modifier.price))
      pending.push(
        `${modifier.external_id}: modificador no importable hasta completar dosis/precio`,
      );
  }
  return { errors, pending: [...new Set(pending)], completeRecipes };
}

function main() {
  const modeIndex = process.argv.indexOf('--mode');
  const mode = modeIndex >= 0 ? process.argv[modeIndex + 1] : 'dry-run';
  if (mode !== 'dry-run')
    throw new Error(
      'Este CLI sólo permite --mode dry-run. La aplicación se ejecuta mediante la suite sobre una base aislada nueva; no existe modo operativo.',
    );
  const manifestIndex = process.argv.indexOf('--manifest');
  const manifestPath =
    manifestIndex >= 0
      ? process.argv[manifestIndex + 1]
      : path.join(__dirname, 'kalali-v1-pilot.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  if (manifest.test_only?.opening_balances_are_synthetic !== true)
    throw new Error('El manifiesto no marca explícitamente sus existencias DEMO como sintéticas.');
  const result = validate(manifest);
  const costIndex = process.argv.indexOf('--costs-file');
  let costReferences = { count: 0, statuses: {} };
  if (costIndex >= 0) {
    const costs = JSON.parse(fs.readFileSync(process.argv[costIndex + 1], 'utf8'));
    const unitDimension = (unit) =>
      unit === 'each'
        ? 'count'
        : ['g', 'kg'].includes(unit)
          ? 'mass'
          : ['ml', 'l'].includes(unit)
            ? 'volume'
            : null;
    for (const row of costs.references || []) {
      const supply = manifest.supplies.find((x) => x.external_id === row.supply_id);
      if (!supply) result.errors.push(`Cost reference: supply ${row.supply_id} does not exist`);
      if (
        !Number.isFinite(row.amount) ||
        row.amount < 0 ||
        !Number.isFinite(row.package_quantity) ||
        row.package_quantity <= 0
      )
        result.errors.push(`Cost reference ${row.supply_id}: amount or package quantity invalid`);
      if (
        !['confirmed', 'provisional', 'pending', 'historical', 'approved'].includes(
          costs.source_status,
        )
      )
        result.errors.push('Cost file source_status is invalid');
      if (!supply || unitDimension(supply.base_unit) !== unitDimension(row.package_unit))
        result.errors.push(
          `Cost reference ${row.supply_id}: package unit incompatible with base unit`,
        );
      costReferences.count++;
      costReferences.statuses[costs.source_status] =
        (costReferences.statuses[costs.source_status] || 0) + 1;
    }
  }
  const output = {
    mode: 'dry-run',
    writes_database: false,
    source_system: manifest.source_system,
    source_release: manifest.source_release,
    result: result.errors.length ? 'rejected' : 'valid-with-pending-records',
    records: {
      categories: manifest.categories.length,
      supplies: manifest.supplies.length,
      preparations: manifest.preparations.length,
      products: manifest.products.length,
      complete_recipes: result.completeRecipes,
      pending_products_or_recipes: manifest.products.length - result.completeRecipes,
      modifiers: manifest.modifiers.length,
    },
    accepted_record_groups: [
      'categories',
      'supplies',
      `${result.completeRecipes} complete product recipes`,
    ],
    pending_count: result.pending.length,
    cost_references: costReferences,
    rejected_count: result.errors.length,
    errors: result.errors,
    pending: result.pending,
    prices: 'provisional candidates only; no approval or production publication',
    stocks: 'synthetic test-only opening balances; never imported operationally',
  };
  console.log(JSON.stringify(output, null, 2));
  if (result.errors.length) process.exitCode = 1;
}

try {
  main();
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
