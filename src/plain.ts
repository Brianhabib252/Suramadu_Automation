/**
 * Alternate entry point that forces plain-text CLI output (no colors/box art)
 * before delegating to the standard index.ts bootstrap.
 */
process.env.NO_COLOR = '1';
process.env.FORCE_ASCII = '1';
process.env.CLI_PLAIN_MODE = '1';

import './index';
