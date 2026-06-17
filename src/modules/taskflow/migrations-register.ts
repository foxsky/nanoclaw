// ADR 0006 contract #3 — taskflow overlay migration registration barrel.
// Two side-effect imports: importing each module runs its top-level
// registerMigration() call, wiring the fork migrations into the core runner
// before runMigrations() executes. Pristine core never imports this file.
import './../../db/migrations/module-user-roles-unique-indexes.js';
import './../../db/migrations/module-taskflow-main-control.js';
