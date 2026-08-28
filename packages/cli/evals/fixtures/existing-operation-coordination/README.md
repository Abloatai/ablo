# Existing task operation

This application already owns its GraphQL contract, authorization, task
transition, and Postgres transaction. The expensive preparation step may run in
a sandbox before the main agent commits the result.

Preserve those owners. The evaluation record and bundled documentation define
the requested coordination change.
