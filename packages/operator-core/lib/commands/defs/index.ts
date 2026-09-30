/**
 * Action registry def loader.
 *
 * Importing this module side-effect-imports every def file in a stable
 * order. Each def file calls `register()` at top level. Order is
 * irrelevant for correctness (defs don't depend on each other) but
 * stable order makes registry-snapshot tests deterministic.
 *
 * Convention: defs import only from `lib/commands/types`, `zod`, and
 * the side-effect targets they wrap. They MUST NOT import from each
 * other or from anywhere that imports the registry transitively (avoids
 * import-cycle hell — see plan §2.3).
 */

import './nav';
import './voice';
import './workspace';
import './harness';
import './chat';
import './delegation';
import './operator';
import './agents';
import './agent-dispatch';
import './recent-activity';
