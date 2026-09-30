/**
 * LocalDriver — today's implicit local behavior captured as an explicit no-op
 * driver (`cloud-deployment-layer-2026-06-06` P-002).
 *
 * The machine is already here: it is already provisioned, the runtime is already
 * installed, and this peer is already a member of the harness/Hive. So all four
 * verbs are no-ops returning the singleton local frame. This is the "well-defined
 * local config" — the default every existing harness uses, with ZERO behavior
 * change (the driver does literally nothing; the local launch path runs as before).
 */
import type { DeploymentConfig, DeploymentContext, DeploymentDriver, Frame } from './types';

/** The singleton local frame handle — the machine is already here. */
export const LOCAL_FRAME: Frame = {
  id: 'local',
  target: 'local',
  placement: 'local',
  kind: 'local',
};

export const LocalDriver: DeploymentDriver = {
  target: 'local',
  placement: 'local',
  async provision(_config: DeploymentConfig, _ctx: DeploymentContext): Promise<Frame> {
    return LOCAL_FRAME;
  },
  async install(_frame: Frame, _config: DeploymentConfig, _ctx: DeploymentContext): Promise<void> {
    /* no-op: the runtime is already installed on this machine */
  },
  async join(_frame: Frame, _config: DeploymentConfig, _ctx: DeploymentContext): Promise<void> {
    /* no-op: this peer is already a member of the harness/Hive */
  },
  async teardown(_frame: Frame, _config: DeploymentConfig, _ctx: DeploymentContext): Promise<void> {
    /* no-op: never destroy the user's own machine */
  },
};
