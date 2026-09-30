/**
 * Compatibility export for operator-core callers. The canonical OMP gateway
 * config builder lives in orchestrator so the server, launcher, and autonomous
 * spawn paths cannot drift on auto/pin semantics.
 */
export {
  OMP_GATEWAY_PLACEHOLDER_KEY,
  OMP_GATEWAY_PROVIDER_ID,
  OMP_MODELS_REL_PATH,
  ompGatewayModelsConfig,
  ompGatewayModelFromSpec,
  ompModelIdFromSpec,
  ompProviderForAccountProvider,
  type OmpGatewayAccountProvider,
  type OmpGatewayModelRoute,
  type OmpGatewayModelsConfig,
  type OmpGatewayModelsConfigOpts,
  type OmpGatewayProvider,
} from '@papercusp/orchestrator/omp-gateway-config';
