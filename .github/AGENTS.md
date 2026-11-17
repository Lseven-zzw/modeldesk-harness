# GitHub Actions

`modeldesk-ci.yml` runs on pull requests into `main` and pushes to `main`. The `server` job runs the Python tests and applies Alembic migrations to a fresh MySQL database. The `admin` job runs the management-console tests and production build.

GitHub's branch rules require both job names. If a job changes names, update the ruleset as part of that change. Use read-only workflow permissions for contributor pull requests.
