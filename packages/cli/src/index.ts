export { applySetOverrides, OPTION_KEYS, defineConfig, loadConfig, mergeOptions, UsageError, type BddrConfig, type BddrOptions, type PluginSpec } from './config.js';
export { runBddr, reportFromEvents, historyReport, historySettings, prepareRun, type PreparedRun, discoverSpecs, discoverSupportFiles, registerTypeScriptLoader, type RunRequest, type RunOutcome } from './run.js';
export { main } from './main.js';
export { validateProject, formatValidation, type ValidationDiagnostic, type ValidationResult, type ValidationSeverity } from './validate.js';
export { migrateProject, formatMigration, type MigrateChange, type MigrateResult } from './migrate.js';
