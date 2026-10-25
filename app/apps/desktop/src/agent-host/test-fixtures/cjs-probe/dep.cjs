// A CommonJS dependency that requires Node builtins at load time, like signal-exit or postcss.
const assert = require("assert");
const { existsSync } = require("fs");
assert.ok(typeof existsSync === "function");
module.exports = { probe: "cjs-require-ok" };
