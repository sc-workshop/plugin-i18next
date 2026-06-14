// Kept in its own module so that import-export modules can use the key
// without importing plugin.ts, which would create a circular runtime
// import (plugin.ts imports the import-export modules).
export const PLUGIN_KEY = "plugin.neko.i18next";
