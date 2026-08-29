import { auditSchemaAccessPolicies } from '../audit.js';
import { camelToSnake, sqlType } from '../ddl.js';
import { classifyMigration, diffSchema, unresolvedBlockers, type BackfillValue, type MigrationSignal, type MigrationStep, type RenameHints } from '../diff.js';
import type { ModelJSON, SchemaJSON } from '../serialize.js';
import { resolveTenancy, tenancyColumn } from '../tenancy.js';
import type { DatabaseSnapshot, DeploymentDirection, DeploymentFinding, DeploymentManifest } from './contracts.js';

const id = (...parts: readonly (string | undefined)[]): string => parts.filter(Boolean).join(':');

function signalFinding(signal: MigrationSignal, direction: DeploymentDirection): DeploymentFinding {
  const destructive = ['drop_model', 'drop_field', 'risky_cast', 'lossy_recreate', 'enum_value_removed'].includes(signal.code);
  return {
    id: id(direction, signal.code, signal.model, signal.field), code: signal.code,
    category: destructive ? 'destructive_contract' : 'data_movement', severity: destructive ? 'error' : 'blocker',
    direction, phase: destructive ? 'contract' : 'backfill', owner: 'application_migration', model: signal.model,
    ...(signal.field ? { field: signal.field } : {}), message: signal.detail,
    action: destructive ? 'Schedule this contract change after compatibility and data verification pass.' : 'Provide and verify a backfill before making this field required.',
  };
}

function stepFinding(step: MigrationStep): DeploymentFinding | null {
  if (step.kind === 'drop_field' || step.kind === 'drop_model') return null;
  if (step.kind === 'create_model') return {
    id: id('source_to_active', step.kind, step.model), code: step.kind, category: 'compatibility', severity: 'info', direction: 'source_to_active',
    phase: 'expand', owner: 'ablo', model: step.model, from: null, to: step.tableName,
    message: `Model "${step.model}" is not active on the target plane.`, action: 'Expand its physical contract, then activate the candidate schema.',
  };
  if (step.kind === 'add_field') return {
    id: id('source_to_active', step.kind, step.model, step.field), code: step.kind, category: 'compatibility', severity: step.meta.isOptional ? 'info' : 'blocker', direction: 'source_to_active',
    phase: 'expand', owner: step.meta.isOptional ? 'ablo' : 'application_migration', model: step.model, field: step.field,
    column: step.meta.column ?? camelToSnake(step.field), from: null, to: step.meta.type,
    message: `Field "${step.model}.${step.field}" is not active on the target plane.`,
    action: step.meta.isOptional ? 'Add the nullable column before activating the candidate schema.' : 'Add the column, backfill existing rows, verify it, then enforce the required contract.',
  };
  if (step.kind === 'rename_model') return {
    id: id('source_to_active', step.kind, step.from, step.to), code: step.kind, category: 'compatibility', severity: 'warning', direction: 'source_to_active',
    phase: 'dual_write', owner: 'application', model: step.to, from: step.from, to: step.to,
    message: `Model "${step.from}" is renamed to "${step.to}".`, action: 'Verify the rename mapping and compatibility window before activation.',
  };
  if (step.kind === 'rename_field') return {
    id: id('source_to_active', step.kind, step.model, step.from, step.to), code: step.kind, category: 'compatibility', severity: 'warning', direction: 'source_to_active',
    phase: 'dual_write', owner: 'application', model: step.model, field: step.to, from: step.from, to: step.to,
    message: `Field "${step.model}.${step.from}" is renamed to "${step.to}".`, action: 'Keep old and new readers/writers compatible through the rename window.',
  };
  return {
    id: id('source_to_active', step.kind, step.model, step.field), code: step.kind, category: 'compatibility', severity: 'warning', direction: 'source_to_active',
    phase: 'dual_write', owner: 'application_migration', model: step.model, field: step.field, from: step.changes,
    message: `Field "${step.model}.${step.field}" changes shape.`, action: 'Apply the ordered physical and compatibility changes, then verify old and current clients.',
  };
}

function databaseSatisfiesRequiredField(
  signal: MigrationSignal,
  source: SchemaJSON,
  database: DatabaseSnapshot | null,
): boolean {
  if (!database || (signal.code !== 'required_field_added' && signal.code !== 'made_required') || !signal.field) return false;
  const model = source.models[signal.model];
  const field = model?.fields[signal.field];
  if (!model || !field || field.isOptional) return false;
  const table = database.tables[model.tableName ?? signal.model];
  const column = table?.columns[field.column ?? camelToSnake(signal.field)];
  return column !== undefined &&
    !column.nullable &&
    (column.nullCount === undefined || column.nullCount === null || column.nullCount === 0) &&
    normalizePgType(column.dataType) === sqlType(field.type);
}

function databaseSatisfiesRiskyCast(
  signal: MigrationSignal,
  source: SchemaJSON,
  database: DatabaseSnapshot | null,
): boolean {
  if (!database || signal.code !== 'risky_cast' || !signal.field) return false;
  const model = source.models[signal.model];
  const field = model?.fields[signal.field];
  // A TEXT column does not prove that existing rows satisfy a newly narrowed
  // enum CHECK constraint; the catalog snapshot currently observes type only.
  if (!model || !field || field.type === 'enum') return false;
  const table = database.tables[model.tableName ?? signal.model];
  const column = table?.columns[field.column ?? camelToSnake(signal.field)];
  return column !== undefined && normalizePgType(column.dataType) === sqlType(field.type);
}

function databasePreservesRemovedApplicationModel(
  signal: MigrationSignal,
  active: SchemaJSON | null,
  source: SchemaJSON,
  database: DatabaseSnapshot | null,
): boolean {
  if (!active || !database || database.ownership !== 'application' || signal.code !== 'drop_model') return false;
  if (source.models[signal.model]) return false;
  const activeModel = active.models[signal.model];
  return activeModel !== undefined && database.tables[activeModel.tableName ?? signal.model] !== undefined;
}

export function reconcileSourceToActive(
  active: SchemaJSON | null,
  source: SchemaJSON,
  hints: RenameHints = {},
  backfills: readonly BackfillValue[] = [],
  database: DatabaseSnapshot | null = null,
): readonly DeploymentFinding[] {
  return reconcileSourceToActiveResult(active, source, hints, backfills, database).findings;
}

export function reconcileSourceToActiveResult(
  active: SchemaJSON | null,
  source: SchemaJSON,
  hints: RenameHints = {},
  backfills: readonly BackfillValue[] = [],
  database: DatabaseSnapshot | null = null,
): { operations: readonly MigrationStep[]; findings: readonly DeploymentFinding[] } {
  const steps = diffSchema(active, source, hints);
  const classification = classifyMigration(steps);
  const blockers = unresolvedBlockers(classification, backfills);
  const requiredFieldsVerified = blockers.filter((signal) => databaseSatisfiesRequiredField(signal, source, database));
  const typeCorrectionsVerified = classification.warnings.filter((signal) => databaseSatisfiesRiskyCast(signal, source, database));
  const removedApplicationModelsPreserved = classification.warnings.filter((signal) =>
    databasePreservesRemovedApplicationModel(signal, active, source, database)
  );
  const databaseVerified = new Set<MigrationSignal>([
    ...requiredFieldsVerified,
    ...typeCorrectionsVerified,
    ...removedApplicationModelsPreserved,
  ]);
  const signals = [
    ...blockers.filter((signal) => !databaseVerified.has(signal)),
    ...classification.warnings.filter((signal) => !databaseVerified.has(signal)),
  ].map((signal) => signalFinding(signal, 'source_to_active'));
  // Keep every classified location out of the ordinary step findings, including
  // blockers discharged by observed PostgreSQL evidence. Otherwise a verified
  // required field falls through and is emitted again as an add_field blocker.
  const signalLocations = new Set([...blockers, ...classification.warnings].map(({ model, field }) => `${model}:${field ?? ''}`));
  const ordinary = steps
    .map(stepFinding)
    .filter((finding): finding is DeploymentFinding => finding !== null)
    .filter((finding) => !signalLocations.has(`${finding.model}:${finding.field ?? ''}`))
    .map((finding) => {
      const hasBackfill = finding.model !== undefined && finding.field !== undefined &&
        backfills.some((backfill) => backfill.model === finding.model && backfill.field === finding.field);
      return hasBackfill && finding.code === 'add_field' && finding.severity === 'blocker'
        ? {
            ...finding,
            severity: 'info' as const,
            phase: 'backfill' as const,
            action: 'Run the declared backfill, verify it completed, then enforce the required contract.',
          }
        : finding;
    });
  const requiredFieldEvidence: DeploymentFinding[] = requiredFieldsVerified.length === 0 ? [] : [{
    id: 'source_to_active:database_migration_verified',
    code: 'database_migration_verified',
    category: 'data_movement',
    severity: 'info',
    direction: 'source_to_active',
    phase: 'verify',
    owner: database?.ownership === 'ablo' ? 'ablo' : 'application_migration',
    from: { requiredChanges: requiredFieldsVerified.length },
    to: 'satisfied',
    message: `PostgreSQL already enforces ${requiredFieldsVerified.length} required field migration(s) absent from the active artifact.`,
    action: 'No synthetic backfill declaration is needed; preserve the matching non-null columns and activate the reviewed schema.',
  }];
  const typeCorrectionEvidence: DeploymentFinding[] = typeCorrectionsVerified.length === 0 ? [] : [{
    id: 'source_to_active:database_type_correction_verified',
    code: 'database_type_correction_verified',
    category: 'destructive_contract',
    severity: 'info',
    direction: 'source_to_active',
    phase: 'verify',
    owner: database?.ownership === 'ablo' ? 'ablo' : 'application_migration',
    from: { typeCorrections: typeCorrectionsVerified.length },
    to: 'source_database_alignment',
    message: `PostgreSQL already matches ${typeCorrectionsVerified.length} candidate field type correction(s) that differ from the active artifact.`,
    action: 'No physical cast is needed; activate the reviewed schema and use forward recovery because the prior artifact no longer matches PostgreSQL.',
  }];
  const removedModelEvidence: DeploymentFinding[] = removedApplicationModelsPreserved.length === 0 ? [] : [{
    id: 'source_to_active:application_model_removal_verified',
    code: 'application_model_removal_verified',
    category: 'compatibility',
    severity: 'warning',
    direction: 'source_to_active',
    phase: 'verify',
    owner: 'application',
    from: { removedModels: removedApplicationModelsPreserved.length },
    to: 'physical_tables_preserved',
    message: `${removedApplicationModelsPreserved.length} model removal(s) only change the served schema; their application-owned PostgreSQL tables remain present.`,
    action: 'Verify no supported client still reads these models, then activate; Ablo will not drop the preserved application tables.',
  }];
  return {
    operations: steps,
    findings: [...signals, ...requiredFieldEvidence, ...typeCorrectionEvidence, ...removedModelEvidence, ...ordinary],
  };
}

export function reconcilePolicyIntent(source: SchemaJSON): readonly DeploymentFinding[] {
  return auditSchemaAccessPolicies(source).map((finding) => ({
    id: id('policy', finding.code, finding.model), code: finding.code, category: 'policy_intent', severity: 'blocker', direction: 'source_to_active',
    phase: 'intent', owner: 'application', model: finding.model, message: finding.message, action: finding.fix,
  }));
}

function normalizePgType(value: string): string {
  const type = value.toLowerCase();
  if (type.includes('timestamp')) return 'TIMESTAMPTZ';
  if (type === 'double precision' || type === 'numeric' || type === 'real' || type.includes('int')) return 'DOUBLE PRECISION';
  if (type === 'boolean') return 'BOOLEAN';
  if (type === 'json' || type === 'jsonb') return 'JSONB';
  return 'TEXT';
}

function requiredColumns(model: ModelJSON): readonly { field?: string; column: string; type: string; nullable: boolean; primary: boolean }[] {
  const orgColumn = tenancyColumn(resolveTenancy(model));
  return [
    { column: 'id', type: 'TEXT', nullable: false, primary: true },
    ...(orgColumn ? [{ column: orgColumn, type: 'TEXT', nullable: false, primary: false }] : []),
    ...Object.entries(model.fields).map(([field, meta]) => ({ field, column: meta.column ?? camelToSnake(field), type: sqlType(meta.type), nullable: meta.isOptional, primary: false })),
  ];
}

function physicalFindings(schema: SchemaJSON, database: DatabaseSnapshot, direction: 'source_to_database' | 'active_to_database'): DeploymentFinding[] {
  const findings: DeploymentFinding[] = [];
  const physicalOwner = database.ownership === 'ablo' ? 'ablo' : 'application_migration';
  for (const [modelKey, model] of Object.entries(schema.models)) {
    if ((model.plane ?? 'tenant') === 'control') continue;
    const tableName = model.tableName ?? modelKey;
    const table = database.tables[tableName];
    if (!table) {
      findings.push({ id: id(direction, 'missing_table', modelKey), code: 'missing_table', category: 'physical_contract', severity: database.ownership === 'ablo' ? 'info' : 'blocker', direction, phase: 'expand', owner: physicalOwner, model: modelKey, from: null, to: tableName, message: `Table "${database.appSchema}.${tableName}" is missing.`, action: database.ownership === 'ablo' ? 'Create it through the reviewed Ablo expand plan.' : 'Create it through the application migration owner, then re-run the plan.' });
      continue;
    }
    for (const expected of requiredColumns(model)) {
      const actual = table.columns[expected.column];
      const base = [direction, modelKey, expected.field, expected.column];
      if (!actual) {
        findings.push({ id: id(...base, 'missing_column'), code: expected.primary ? 'missing_identity_column' : 'missing_column', category: 'physical_contract', severity: database.ownership === 'ablo' ? 'info' : 'blocker', direction, phase: 'expand', owner: physicalOwner, model: modelKey, ...(expected.field ? { field: expected.field } : {}), column: expected.column, from: null, to: expected.type, message: `Column "${tableName}.${expected.column}" is missing.`, action: database.ownership === 'ablo' ? 'Create it through the reviewed Ablo expand plan.' : expected.primary ? 'Add or explicitly map a stable row identity and enforce uniqueness and non-nullness.' : 'Add the column through the application migration owner, then re-run the plan.' });
        continue;
      }
      if (expected.primary && !actual.primary && !actual.unique) findings.push({ id: id(...base, 'identity_not_unique'), code: 'identity_not_unique', category: 'physical_contract', severity: 'blocker', direction, phase: 'expand', owner: physicalOwner, model: modelKey, column: expected.column, from: { primary: actual.primary, unique: actual.unique }, to: { primary: true }, message: `Column "${tableName}.${expected.column}" is present but is not a usable unique row identity.`, action: 'Verify uniqueness and non-nullness, then add a primary-key or unique constraint.' });
      const actualType = normalizePgType(actual.dataType);
      if (actualType !== expected.type) findings.push({ id: id(...base, 'column_type_mismatch'), code: 'column_type_mismatch', category: 'physical_contract', severity: 'blocker', direction, phase: 'expand', owner: physicalOwner, model: modelKey, ...(expected.field ? { field: expected.field } : {}), column: expected.column, from: actualType, to: expected.type, message: `Column "${tableName}.${expected.column}" is ${actualType}; the schema expects ${expected.type}.`, action: 'Review and apply a safe type migration before activation.' });
      if (!expected.nullable && actual.nullable) findings.push({ id: id(...base, 'column_nullable'), code: 'column_nullable', category: 'data_movement', severity: 'blocker', direction, phase: 'backfill', owner: physicalOwner, model: modelKey, ...(expected.field ? { field: expected.field } : {}), column: expected.column, from: 'nullable', to: 'required', message: `Column "${tableName}.${expected.column}" is nullable; the schema requires a value.`, action: 'Backfill NULL rows, verify none remain, then enforce NOT NULL.' });
      if (expected.column === tenancyColumn(resolveTenancy(model)) && actual.nullCount !== undefined && actual.nullCount !== null && actual.nullCount > 0) {
        findings.push({ id: id(...base, 'unstamped_tenancy_rows'), code: 'unstamped_tenancy_rows', category: 'data_movement', severity: 'blocker', direction, phase: 'backfill', owner: 'application_migration', model: modelKey, column: expected.column, from: actual.nullCount, to: 0, message: `Table "${tableName}" has ${actual.nullCount >= 501 ? '500+' : actual.nullCount} row(s) with no "${expected.column}" routing value.`, action: 'Backfill the routing value, verify zero NULL rows, then run `ablo connect resnapshot`.' });
      }
    }
    for (const column of ['created_by', 'created_at', 'updated_at']) if (!table.columns[column]) findings.push({ id: id(direction, modelKey, column, 'base_column_degraded'), code: 'base_column_degraded', category: 'advisory', severity: 'warning', direction, phase: 'intent', owner: 'application', model: modelKey, column, message: `Table "${tableName}" has no "${column}"; audit or ordering metadata may be reduced.`, action: 'Declare and add this field only if the application needs that metadata.' });
    for (const [field, meta] of Object.entries(model.fields)) if (meta.isIndexed) {
      const column = meta.column ?? camelToSnake(field);
      const index = table.indexes?.find((candidate) => candidate.columns.length === 1 && candidate.columns[0] === column && candidate.valid && candidate.ready);
      if (!index) findings.push({ id: id(direction, modelKey, field, 'declared_index_missing'), code: 'declared_index_missing', category: 'physical_contract', severity: 'blocker', direction, phase: 'expand', owner: physicalOwner, model: modelKey, field, column, message: `Field "${modelKey}.${field}" is declared indexed, but "${tableName}.${column}" has no ready, valid index.`, action: 'Create the index concurrently, wait until it is ready and valid, then re-run the plan.' });
    }
    for (const relation of Object.values(model.relations)) if (relation.type === 'belongsTo') {
      const target = schema.models[relation.target];
      const expectedTable = target?.tableName ?? relation.target;
      const constraint = table.foreignKeys?.find((foreignKey) => foreignKey.columns.length === 1 && foreignKey.columns[0] === relation.foreignKeyColumn && foreignKey.referencedTable === expectedTable);
      if (!constraint) findings.push({ id: id(direction, modelKey, relation.foreignKey, 'foreign_key_unverified'), code: 'foreign_key_unverified', category: 'advisory', severity: 'warning', direction, phase: 'verify', owner: physicalOwner, model: modelKey, field: relation.foreignKey, column: relation.foreignKeyColumn, message: `Relation "${modelKey}.${relation.foreignKey}" has no observed PostgreSQL foreign key to "${expectedTable}".`, action: 'If the application database owns relational integrity, add the foreign key NOT VALID and validate it after existing rows are clean.' });
      else if (!constraint.validated) findings.push({ id: id(direction, modelKey, relation.foreignKey, 'foreign_key_not_validated'), code: 'foreign_key_not_validated', category: 'physical_contract', severity: 'warning', direction, phase: 'verify', owner: physicalOwner, model: modelKey, field: relation.foreignKey, column: relation.foreignKeyColumn, message: `Foreign key "${constraint.name}" exists but has not validated existing rows.`, action: 'Run VALIDATE CONSTRAINT under the verification gate before relying on it.' });
    }
    if (database.ownership === 'application' && table.publicationMember === false) findings.push({ id: id(direction, modelKey, 'publication_missing'), code: 'publication_missing', category: 'physical_contract', severity: 'blocker', direction, phase: 'expand', owner: 'application_migration', model: modelKey, message: `Table "${tableName}" is not a member of the connected logical-replication publication.`, action: 'Add the table to the publication through the database owner, then verify replication before activation.' });
    if (table.rowLevelSecurity === true && table.forceRowLevelSecurity !== true) findings.push({ id: id(direction, modelKey, 'rls_not_forced'), code: 'rls_not_forced', category: 'advisory', severity: 'warning', direction, phase: 'verify', owner: physicalOwner, model: modelKey, message: `Table "${tableName}" enables RLS but does not force it for the table owner.`, action: 'Confirm the runtime role cannot bypass the intended policy, or FORCE ROW LEVEL SECURITY.' });
  }
  return findings;
}

export function reconcileSchemaToDatabase(schema: SchemaJSON, database: DatabaseSnapshot | null, direction: 'source_to_database' | 'active_to_database'): readonly DeploymentFinding[] {
  if (!database) return [{ id: `${direction}:database_unobserved`, code: 'database_unobserved', category: 'observation', severity: 'blocker', direction, phase: 'verify', owner: 'application_migration', message: 'The connected PostgreSQL shape was not observed.', action: 'Provide the application migration credential and re-run the plan against the confirmed database.' }];
  return physicalFindings(schema, database, direction);
}

/** Client-runtime projection of the same compatibility finding contract. */
export function reconcileClientToActive(
  changed: readonly string[],
  unpushed: readonly string[],
  serverLabel: string,
  fieldDifferences: readonly { model: string; field: string; direction: 'client_only' | 'active_only' | 'changed'; detail: string }[] = [],
): readonly DeploymentFinding[] {
  return [
    ...fieldDifferences.map((difference): DeploymentFinding => ({
      id: id('client_to_active', `field_${difference.direction}`, difference.model, difference.field), code: `field_${difference.direction}`,
      category: 'compatibility', severity: difference.direction === 'active_only' ? 'warning' : 'error', direction: 'client_to_active',
      phase: difference.direction === 'active_only' ? 'verify' : 'dual_write', owner: 'application', model: difference.model, field: difference.field,
      message: `Field "${difference.model}.${difference.field}" is ${difference.detail} at ${serverLabel}.`,
      action: 'Run `ablo plan` for the ordered compatibility action before deploying this build.',
    })),
    ...changed.map((model): DeploymentFinding => ({
      id: id('client_to_active', 'model_changed', model), code: 'model_changed', category: 'compatibility', severity: 'warning',
      direction: 'client_to_active', phase: 'verify', owner: 'application', model,
      message: `Model "${model}" differs between this build and the active schema at ${serverLabel}.`,
      action: 'Run `ablo plan` to see field direction; use `ablo status` to confirm the deployed target.',
    })),
    ...unpushed.map((model): DeploymentFinding => ({
      id: id('client_to_active', 'model_unpushed', model), code: 'model_unpushed', category: 'compatibility', severity: 'error',
      direction: 'client_to_active', phase: 'dual_write', owner: 'ablo', model,
      message: `Model "${model}" is declared by this build but is not active at ${serverLabel}.`,
      action: 'Run `ablo plan`, resolve its gates, then run `ablo push` with the reviewed schema.',
    })),
  ];
}

/** Turns an explicit lifecycle manifest into the same findings consumed by every surface. */
export function reconcileDeploymentManifest(manifest: DeploymentManifest | undefined): readonly DeploymentFinding[] {
  if (!manifest) return [];
  const findings: DeploymentFinding[] = [];
  const gates = new Map(manifest.gates.map((gate) => [gate.id, gate]));
  const phases = ['expand', 'dual_write', 'backfill', 'verify', 'switch', 'contract'] as const;
  const targetIndex = phases.indexOf(manifest.targetPhase);
  for (const gate of manifest.gates) {
    const unmet = gate.dependsOn.filter((dependency) => gates.get(dependency)?.status !== 'satisfied');
    const contractWithoutApproval = gate.phase === 'contract' && !gate.approval;
    const future = phases.indexOf(gate.phase) > targetIndex;
    const blocked = !future && (gate.status === 'pending' || unmet.length > 0 || contractWithoutApproval);
    findings.push({
      id: id('manifest', manifest.id, gate.id), code: future ? 'lifecycle_future' : contractWithoutApproval ? 'contract_approval_required' : unmet.length > 0 ? 'lifecycle_dependency_unsatisfied' : `lifecycle_${gate.status}`,
      category: gate.phase === 'contract' ? 'destructive_contract' : gate.phase === 'backfill' ? 'data_movement' : 'compatibility',
      severity: blocked ? 'blocker' : future || gate.status === 'satisfied' ? 'info' : 'warning', direction: 'source_to_active', phase: gate.phase,
      owner: gate.owner, model: gate.resource.split('.')[0], ...(gate.resource.includes('.') ? { field: gate.resource.split('.').slice(1).join('.') } : {}),
      message: future ? `Lifecycle gate "${gate.title}" is visible but belongs after this ${manifest.targetPhase} deployment.` : blocked ? `Lifecycle gate "${gate.title}" is not satisfied${unmet.length ? `; waiting for ${unmet.join(', ')}` : ''}.` : `Lifecycle gate "${gate.title}" is ${gate.status}.`,
      action: contractWithoutApproval ? 'Approve contract as a separate reviewed deployment and record the approval identifier.' : gate.action,
      dependsOn: gate.dependsOn.map((dependency) => id('manifest', manifest.id, dependency)),
    });
  }
  if (manifest.live) {
    const phasesByResource = new Map<string, Set<string>>();
    for (const gate of manifest.gates) {
      const phases = phasesByResource.get(gate.resource) ?? new Set<string>();
      phases.add(gate.phase);
      phasesByResource.set(gate.resource, phases);
    }
    for (const [resource, phases] of phasesByResource) if (phases.has('expand') && phases.has('contract')) {
      findings.push({ id: id('manifest', manifest.id, resource, 'mixed_expand_contract'), code: 'mixed_expand_contract', category: 'destructive_contract', severity: 'blocker', direction: 'source_to_active', phase: 'contract', owner: 'application', model: resource.split('.')[0], ...(resource.includes('.') ? { field: resource.split('.').slice(1).join('.') } : {}), message: `Live resource "${resource}" combines expand and contract in one deployment manifest.`, action: 'Remove contract from this manifest; deploy and verify expand first, then submit a separately approved contract manifest.' });
    }
  }
  return findings;
}
