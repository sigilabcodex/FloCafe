# FloCafe Production para Kalali: handover técnico

## Estado entregado

La rama `experiment/production-batches` contiene tres checkpoints locales:

| Entrega | Commit |
| --- | --- |
| Production v0.1: lotes, receta e inventario | `a28b754b` |
| Production v0.2: tipos de movimiento, ciclo de vida y API | `594ff6e0` |
| Production v0.3: versiones de procesos y ejecución de etapas | `7056feff` |

v0.3 no modifica POS ni KDS de ventas. No incluye interfaz gráfica, planificador, recetas recursivas ni cambios a la instalación Demo. El commit de este handover se mantiene separado del código.

## Arquitectura y datos

El dominio usa los servicios backend existentes de recetas de preparación, suministros, movimientos de inventario y costos. `main/services/production.ts` coordina recetas, lotes, movimientos y ejecución de etapas. `main/routes/production.ts` expone el API autenticado. La migración SQLite se declara al final del registro en `main/db.ts`.

| Migración | Cambio |
| --- | --- |
| v126 `add_production_batches` | Recetas versionadas de preparación, órdenes/lotes independientes de ventas, snapshots de ingredientes, eventos y movimientos de insumos elaborados. |
| v127 `add_production_movement_types_and_terminal_states` | Tipos explícitos `production_issue` y `production_output`; estados terminales de cancelación y abandono. |
| v128 `add_versioned_production_processes` | Versiones de plantillas, definiciones de etapas, snapshots de etapas en la orden, eventos de transición y referencia opcional desde `production_orders`. |

v128 agrega `production_process_versions`, `production_process_steps`, `production_order_steps` y `production_step_events`. Una versión de proceso se crea como una nueva versión; el API no ofrece edición de definiciones existentes. Crear una versión activa nueva desactiva la anterior. Al crear un lote se copian sus etapas, dependencias y metadatos, por lo que el lote conserva el proceso con el que fue creado. Las órdenes previas con `process_version_id = NULL` conservan el comportamiento v0.2.

Cada etapa tiene clave estable, nombre, instrucciones, tipo (`operation`, `wait` o `check`), duración prevista opcional, dependencias, indicador opcional, rol y responsable sugeridos, recurso y, si es una verificación, una indicación de resultado. Se rechazan claves duplicadas, dependencias ausentes, dependencias propias y ciclos.

## API y permisos

El router se monta bajo `/api/production`. Las rutas requieren la autenticación normal de FloCafe y estos permisos:

| Permiso | Uso |
| --- | --- |
| `production.view` | Consultar versiones, órdenes, etapas y eventos. |
| `production.manage` | Crear versiones de procesos de preparación. |
| `production.execute` | Crear/operar órdenes y transicionar etapas. |

Rutas v0.3:

```text
GET  /api/production/recipes/:recipeId/process-versions
POST /api/production/recipes/:recipeId/process-versions
GET  /api/production/process-versions/:processVersionId
GET  /api/production/orders/:orderId/steps
GET  /api/production/orders/:orderId/step-events?step_id=:stepId
GET  /api/production/orders/:orderId/steps/:stepId/events
POST /api/production/orders/:orderId/steps/:stepId/start
POST /api/production/orders/:orderId/steps/:stepId/complete
POST /api/production/orders/:orderId/steps/:stepId/skip
POST /api/production/orders/:orderId/steps/:stepId/block
POST /api/production/orders/:orderId/steps/:stepId/resume
```

Las transiciones requieren `expected_version` e `idempotency_key`. Omitir una etapa opcional o bloquear una etapa requiere `reason`. Completar una etapa `check` requiere `verification_result`. Las dependencias deben estar completadas u omitidas antes de iniciar/completar la etapa dependiente. El historial guarda actor, acción, solicitud y hora.

## Inventario y estados

```text
Orden: queued ──start──> in_progress ──complete(real yield)──> completed
   └──cancel──> cancelled
                         └──abandon(reason)──> abandoned

Etapa: pending ──start──> in_progress ──complete──> completed
   ├──skip(reason, solo opcional)──────────────────> skipped
   └──block(reason)──> blocked ──resume──> in_progress
```

- Crear una orden no reserva ni descuenta ingredientes.
- Iniciar el lote descuenta transaccionalmente los ingredientes con `production_issue`; la idempotencia impide repetir el cargo.
- Las etapas no modifican existencias.
- Completar el lote registra el rendimiento real y acredita el insumo elaborado con `production_output`.
- Cancelar una orden pendiente no crea movimientos. Abandonar una orden iniciada no repone ingredientes, porque pueden haber sido procesados.
- Una orden con proceso no se puede completar con etapas obligatorias pendientes o bloqueadas. Una etapa opcional pendiente puede quedar sin ejecutar; una opcional iniciada o bloqueada debe resolverse.
- Una orden sin proceso sigue usando el flujo v0.2.

Los tiempos reales de etapa se calculan desde el primer inicio hasta la finalización. Si se bloquea y luego se reanuda, ese tiempo incluye el intervalo bloqueado; v0.3 no acumula segmentos activos separados. La duración prevista de una espera es informativa: la aplicación no espera ni finaliza etapas automáticamente.

## Ejemplos de proceso

Las pruebas contienen dos plantillas ilustrativas, no recetas ni tiempos aprobados para Kalali:

- **Producir brioche:** una operación con duración prevista de ejemplo.
- **Brioche detallado:** pesar, amasar, fermentar, formar, segunda fermentación, glaseado opcional, hornear, enfriar y verificar rendimiento/calidad. Dependencias lineales y algunos campos de recursos, roles, espera y verificación.

## Ejecución y pruebas

El runtime verificado fue Node `v22.23.4` desde `/tmp/flocafe-toolchain/node-v22.23.4-linux-x64/bin`. `/usr/bin/node` no se modificó. Los tests backend crean sus bases de prueba en directorios temporales y sustituyen el acceso a Electron. Ejecutar las suites desde la raíz del repositorio:

```sh
export PATH=/tmp/flocafe-toolchain/node-v22.23.4-linux-x64/bin:$PATH
npm run test:production-processes
npm run test:production-batches
npm run test:production-api
npm run test:recipe-order-lifecycle
npm run test:supplies-service
npm run test:inventory-ledger
npm run test:migration-registry
npm run test:upgrade-path
npm run test:authorization-permissions
npm run test:authz-phase3
npm run test:script-coverage
npx tsc --noEmit -p tsconfig.json
```

Resultados verificados durante este cierre:

| Suite/control | Resultado |
| --- | --- |
| `test:production-processes` | 45/45 |
| `test:production-batches` | 48/48 |
| `test:production-api` | 46/46 |
| `test:recipe-order-lifecycle` | 67/67 |
| `test:supplies-service` | 65/65 |
| `test:inventory-ledger` | 82/82, 60/60 y suite de precisión/respaldo aprobada |
| `test:migration-registry` | 389/389 migraciones y verificaciones |
| `test:upgrade-path` | Aprobada; incluye fixtures temporales v123→v128 y anteriores |
| `test:authorization-permissions` | Aprobada; API, auditoría y rutas estáticas |
| `test:authz-phase3` | 65/65 |
| `test:script-coverage` | Aprobada: 281 scripts alcanzables, 342 pruebas en suite por defecto, contrato del harness verificado |
| TypeScript | `npx tsc --noEmit -p tsconfig.json`, aprobado |
| Lint enfocado | `oxlint` sobre los archivos modificados, exit 0; muestra warnings existentes de `any` y parámetros no usados en `main/db.ts` |
| Formato enfocado | `oxfmt --check` sobre los archivos modificados, aprobado |
| Diff | `git diff --check`, aprobado |

El primer intento de `test:script-coverage` dentro del sandbox falló porque el subtest spawn de `test-harness-assertions.test.ts` recibió `EPERM`; el sandbox impedía lanzar el proceso hijo. La fixture se ejecutó correctamente al permitir el spawn. No se modificó el harness porque no era un defecto del código ni de v0.3.

## Límites y trabajo posterior

- No hay Production Board ni vista móvil; las rutas del backend son la única interfaz nueva.
- No hay planificador, temporizadores de espera, avisos de vencimiento ni asignación efectiva de responsables o recursos. Esos campos son sugerencias.
- Las etapas de preparación son planas. No hay recetas recursivas, preparaciones encadenadas automáticamente ni división de un lote entre sublotes.
- No hay edición de una versión de proceso publicada, reasignación operativa, lotes parciales, control de rendimiento por etapa, ni acumulación de duración activa fuera del intervalo inicio-final.
- El API no crea movimientos por etapas; solo el inicio y finalización del lote alteran inventario.

### Alcance mínimo recomendado para Production Board v0.4

1. Vista móvil de lotes en cola y en curso, con búsqueda simple y contador de etapas completadas.
2. Vista de operador para una etapa: instrucciones, dependencias, recurso/rol sugerido y acciones válidas según estado.
3. Captura de verificación, motivo de bloqueo/omisión y confirmación del rendimiento real al completar el lote.
4. Historial de eventos visible para supervisión, con actor y hora.
5. Consumir las rutas `/api/production` existentes; no integrar el Board con el KDS de ventas ni añadir planificación automática en esta versión.

## Precauciones de datos

- Las suites incluidas preparan sus propias bases temporales. Para pruebas manuales, revisa `main/db.ts:getDbPath()` y `dev-server.js`: `FLO_E2E_DB_PATH` selecciona explícitamente la SQLite de E2E y `FLO_DEV_USER_DATA` aísla `userData` de `dev-server.js`. Usa rutas nuevas bajo `/tmp`, confirma la ruta efectiva antes de arrancar el servidor y no apuntes a la carpeta de Demo. No se validó ninguna operación contra Demo.
- No uses credenciales reales en pruebas API; los tests generan usuarios, tokens y secretos de prueba.
- No ejecutes `node dev-server.js` ni la aplicación de escritorio para validar Production si comparten rutas de datos o puertos con la instalación existente.
- No migres una base real como paso de prueba. La compatibilidad de v126/v127 se verificó solo con fixtures y SQLite desechables.
- Mantén Node 22 aislado mediante el `PATH` anterior. No cambies `/usr/bin/node`, gestores globales ni otros proyectos.
- El commit v0.3 y este handover son locales. No hay push ni cambios en `main`.
