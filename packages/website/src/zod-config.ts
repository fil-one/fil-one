import { z } from 'zod';

// CSP forbids `eval` / `new Function`; Zod's JIT probe (`util.allowsEval`)
// would otherwise trigger a script-src violation on every page load.
z.config({ jitless: true });
