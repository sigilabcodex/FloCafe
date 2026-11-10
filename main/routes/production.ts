import { Router, Request, Response } from 'express';
import { getDatabase } from '../db';
import { requirePermission } from '../services/authorization';
import {
  ProductionServiceError,
  abandonProductionOrder,
  cancelProductionOrder,
  completeProductionOrder,
  createPrepRecipeVersion,
  createProductionOrder,
  createProductionProcessVersion,
  getProductionOrder,
  getProductionProcessVersion,
  listPrepRecipeVersions,
  listProductionOrderEvents,
  listProductionOrderMovements,
  listProductionOrderSteps,
  listProductionOrders,
  listProductionProcessVersions,
  listProductionStepEvents,
  startProductionOrder,
  transitionProductionOrderStep,
  type ProductionOrderStatus,
  type ProductionStepAction,
} from '../services/production';
import type { SupplyUnit } from '../services/units';

const router = Router();
const ORDER_STATUSES = ['queued', 'in_progress', 'completed', 'cancelled', 'abandoned'] as const;

function actorId(req: Request): string {
  return String((req as Request & { user?: { userId?: string } }).user?.userId || '');
}

function getId(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > 128) {
    throw new ProductionServiceError(
      400,
      `${name} must be a non-empty string of at most 128 characters`,
      'id_invalid',
    );
  }
  return value.trim();
}

function expectedVersion(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new ProductionServiceError(
      400,
      'expected_version must be a non-negative integer',
      'version_invalid',
    );
  }
  return Number(value);
}

function sendError(res: Response, error: unknown): void {
  const details = error as { statusCode?: unknown; message?: unknown };
  const statusCode = Number.isInteger(details.statusCode) ? (details.statusCode as number) : 500;
  if (statusCode >= 500) console.error('[API] Production operation failed:', error);
  res
    .status(statusCode)
    .json({ error: statusCode >= 500 ? 'Internal server error' : details.message });
}

router.get('/recipes', requirePermission('production.view'), (_req: Request, res: Response) => {
  try {
    res.json({ recipes: listPrepRecipeVersions(getDatabase()) });
  } catch (error) {
    sendError(res, error);
  }
});

router.get(
  '/recipes/:supplyId',
  requirePermission('production.view'),
  (req: Request, res: Response) => {
    try {
      res.json({
        recipes: listPrepRecipeVersions(getDatabase(), getId(req.params.supplyId, 'supply_id')),
      });
    } catch (error) {
      sendError(res, error);
    }
  },
);

router.get(
  '/recipes/:recipeId/process-versions',
  requirePermission('production.view'),
  (req: Request, res: Response) => {
    try {
      res.json({
        process_versions: listProductionProcessVersions(
          getDatabase(),
          getId(req.params.recipeId, 'recipe_id'),
        ),
      });
    } catch (error) {
      sendError(res, error);
    }
  },
);

router.post(
  '/recipes/:recipeId/process-versions',
  requirePermission('production.manage'),
  (req: Request, res: Response) => {
    try {
      const body = req.body || {};
      const processVersion = createProductionProcessVersion(getDatabase(), {
        recipeId: getId(req.params.recipeId, 'recipe_id'),
        name: body.name,
        steps: body.steps,
        actorUserId: actorId(req),
      });
      res.status(201).json({ process_version: processVersion });
    } catch (error) {
      sendError(res, error);
    }
  },
);

router.get(
  '/process-versions/:processVersionId',
  requirePermission('production.view'),
  (req: Request, res: Response) => {
    try {
      res.json({
        process_version: getProductionProcessVersion(
          getDatabase(),
          getId(req.params.processVersionId, 'process_version_id'),
        ),
      });
    } catch (error) {
      sendError(res, error);
    }
  },
);

router.post(
  '/recipes/:supplyId/versions',
  requirePermission('production.manage'),
  (req: Request, res: Response) => {
    try {
      const body = req.body || {};
      const components = Array.isArray(body.components)
        ? body.components.map((component: unknown) => {
            if (!component || typeof component !== 'object' || Array.isArray(component)) {
              throw new ProductionServiceError(
                400,
                'Each component must be an object',
                'component_invalid',
              );
            }
            const item = component as Record<string, unknown>;
            return {
              supplyId: item.supply_id,
              quantity: item.quantity,
              unit: item.unit as SupplyUnit,
            };
          })
        : body.components;
      const recipe = createPrepRecipeVersion(getDatabase(), {
        outputSupplyId: getId(req.params.supplyId, 'supply_id'),
        yieldQuantity: body.yield_quantity,
        components,
        actorUserId: actorId(req),
      });
      res.status(201).json({ recipe });
    } catch (error) {
      sendError(res, error);
    }
  },
);

router.get('/orders', requirePermission('production.view'), (req: Request, res: Response) => {
  try {
    const rawStatus = req.query.status;
    if (
      rawStatus !== undefined &&
      (typeof rawStatus !== 'string' ||
        !ORDER_STATUSES.includes(rawStatus as (typeof ORDER_STATUSES)[number]))
    ) {
      throw new ProductionServiceError(400, 'status is invalid', 'status_invalid');
    }
    const rawLimit = req.query.limit;
    const limit = rawLimit === undefined ? 100 : Number(rawLimit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
      throw new ProductionServiceError(
        400,
        'limit must be an integer from 1 to 500',
        'limit_invalid',
      );
    }
    res.json({
      orders: listProductionOrders(getDatabase(), {
        status: rawStatus as ProductionOrderStatus | undefined,
        limit,
      }),
    });
  } catch (error) {
    sendError(res, error);
  }
});

router.post('/orders', requirePermission('production.execute'), (req: Request, res: Response) => {
  try {
    const body = req.body || {};
    const order = createProductionOrder(getDatabase(), {
      recipeId: getId(body.recipe_id, 'recipe_id'),
      plannedQuantity: body.planned_quantity,
      idempotencyKey: getId(body.idempotency_key, 'idempotency_key'),
      actorUserId: actorId(req),
    });
    res.status(201).json({ order });
  } catch (error) {
    sendError(res, error);
  }
});

router.get(
  '/orders/:orderId/steps/:stepId/events',
  requirePermission('production.view'),
  (req: Request, res: Response) => {
    try {
      res.json({
        events: listProductionStepEvents(
          getDatabase(),
          getId(req.params.orderId, 'order_id'),
          getId(req.params.stepId, 'step_id'),
        ),
      });
    } catch (error) {
      sendError(res, error);
    }
  },
);

router.get(
  '/orders/:orderId/steps',
  requirePermission('production.view'),
  (req: Request, res: Response) => {
    try {
      res.json({
        steps: listProductionOrderSteps(getDatabase(), getId(req.params.orderId, 'order_id')),
      });
    } catch (error) {
      sendError(res, error);
    }
  },
);

router.get(
  '/orders/:orderId/step-events',
  requirePermission('production.view'),
  (req: Request, res: Response) => {
    try {
      const stepId =
        req.query.step_id === undefined ? undefined : getId(req.query.step_id, 'step_id');
      res.json({
        events: listProductionStepEvents(
          getDatabase(),
          getId(req.params.orderId, 'order_id'),
          stepId,
        ),
      });
    } catch (error) {
      sendError(res, error);
    }
  },
);

function stageTransition(action: ProductionStepAction) {
  return (req: Request, res: Response) => {
    try {
      const body = req.body || {};
      const step = transitionProductionOrderStep(
        getDatabase(),
        getId(req.params.orderId, 'order_id'),
        getId(req.params.stepId, 'step_id'),
        {
          action,
          actorUserId: actorId(req),
          expectedVersion: expectedVersion(body.expected_version),
          idempotencyKey: getId(body.idempotency_key, 'idempotency_key'),
          reason: body.reason,
          verificationResult: body.verification_result,
        },
      );
      res.json({ step });
    } catch (error) {
      sendError(res, error);
    }
  };
}

router.post(
  '/orders/:orderId/steps/:stepId/start',
  requirePermission('production.execute'),
  stageTransition('start'),
);
router.post(
  '/orders/:orderId/steps/:stepId/complete',
  requirePermission('production.execute'),
  stageTransition('complete'),
);
router.post(
  '/orders/:orderId/steps/:stepId/skip',
  requirePermission('production.execute'),
  stageTransition('skip'),
);
router.post(
  '/orders/:orderId/steps/:stepId/block',
  requirePermission('production.execute'),
  stageTransition('block'),
);
router.post(
  '/orders/:orderId/steps/:stepId/resume',
  requirePermission('production.execute'),
  stageTransition('resume'),
);

router.get(
  '/orders/:orderId/events',
  requirePermission('production.view'),
  (req: Request, res: Response) => {
    try {
      res.json({
        events: listProductionOrderEvents(getDatabase(), getId(req.params.orderId, 'order_id')),
      });
    } catch (error) {
      sendError(res, error);
    }
  },
);

router.get(
  '/orders/:orderId/movements',
  requirePermission('production.view'),
  (req: Request, res: Response) => {
    try {
      res.json({
        movements: listProductionOrderMovements(
          getDatabase(),
          getId(req.params.orderId, 'order_id'),
        ),
      });
    } catch (error) {
      sendError(res, error);
    }
  },
);

router.get(
  '/orders/:orderId',
  requirePermission('production.view'),
  (req: Request, res: Response) => {
    try {
      res.json({ order: getProductionOrder(getDatabase(), getId(req.params.orderId, 'order_id')) });
    } catch (error) {
      sendError(res, error);
    }
  },
);

router.post(
  '/orders/:orderId/start',
  requirePermission('production.execute'),
  (req: Request, res: Response) => {
    try {
      const order = startProductionOrder(
        getDatabase(),
        getId(req.params.orderId, 'order_id'),
        actorId(req),
        expectedVersion(req.body?.expected_version),
      );
      res.json({ order });
    } catch (error) {
      sendError(res, error);
    }
  },
);

router.post(
  '/orders/:orderId/complete',
  requirePermission('production.execute'),
  (req: Request, res: Response) => {
    try {
      const body = req.body || {};
      const order = completeProductionOrder(getDatabase(), getId(req.params.orderId, 'order_id'), {
        actualQuantity: body.actual_quantity,
        actorUserId: actorId(req),
        expectedVersion: expectedVersion(body.expected_version),
      });
      res.json({ order });
    } catch (error) {
      sendError(res, error);
    }
  },
);

router.post(
  '/orders/:orderId/cancel',
  requirePermission('production.manage'),
  (req: Request, res: Response) => {
    try {
      const body = req.body || {};
      const order = cancelProductionOrder(getDatabase(), getId(req.params.orderId, 'order_id'), {
        reason: body.reason,
        actorUserId: actorId(req),
        expectedVersion: expectedVersion(body.expected_version),
      });
      res.json({ order });
    } catch (error) {
      sendError(res, error);
    }
  },
);

router.post(
  '/orders/:orderId/abandon',
  requirePermission('production.manage'),
  (req: Request, res: Response) => {
    try {
      const body = req.body || {};
      const order = abandonProductionOrder(getDatabase(), getId(req.params.orderId, 'order_id'), {
        reason: body.reason,
        actorUserId: actorId(req),
        expectedVersion: expectedVersion(body.expected_version),
      });
      res.json({ order });
    } catch (error) {
      sendError(res, error);
    }
  },
);

export const productionRoutes = router;
