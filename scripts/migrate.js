// npm run migrate
// Brings the database tables up to date with the entities (TypeORM schema sync). This project keeps
// the auto-create behaviour on purpose, so there are no migration files; this is the one command to
// run against Neon after the entities change (the same as `npm run db:sync`).
import './sync-db.js';
