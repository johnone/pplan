import { db } from './db';
import {
  organizations,
  users,
  staff,
  staffAddresses,
  roles,
  shifts,
  shiftAssignments,
  shiftAssignmentLogs,
  auditLogs,
} from './schema';
import { eq, and, isNull, desc, gte, isNotNull, sql } from 'drizzle-orm';

// ============================================================================
// SCD TYPE 2 (SLOWLY CHANGING DIMENSIONS) FUNCTIONS
// ============================================================================

/**
 * SCD Type 2 Helper - Erstellt eine neue Version eines Datensatzes
 * und markiert die alte Version als historisch
 */
export async function createNewVersion<T extends Record<string, any>>({
  table,
  currentId,
  updates,
  performedBy,
  performedByStaff,
  ipAddress,
  userAgent,
  metadata,
}: {
  table: any;
  currentId: string;
  updates: Partial<T>;
  performedBy?: string;
  performedByStaff?: string;
  ipAddress?: string;
  userAgent?: string;
  metadata?: Record<string, any>;
}) {
  return await db.transaction(async (tx) => {
    // 1. Hole aktuelle Version
    const current = await tx.query[table._.name].findFirst({
      where: and(eq(table.id, currentId), eq(table.is_current, true)),
    });

    if (!current) {
      throw new Error('Current version not found');
    }

    const now = new Date();

    // 2. Markiere aktuelle Version als historisch
    await tx
      .update(table)
      .set({
        valid_to: now,
        is_current: false,
        updated_at: now,
      })
      .where(eq(table.id, currentId));

    // 3. Erstelle neue Version
    const [newVersion] = await tx
      .insert(table)
      .values({
        ...current,
        ...updates,
        id: undefined, // Neue UUID wird generiert
        previous_version_id: currentId,
        valid_from: now,
        valid_to: null,
        is_current: true,
        created_at: current.created_at, // Behalte ursprüngliches Erstellungsdatum
        updated_at: now,
      })
      .returning();

    // 4. Erstelle Audit-Log
    const changedFields = Object.keys(updates);
    const oldValues: Record<string, any> = {};
    const newValues: Record<string, any> = {};

    changedFields.forEach((field) => {
      oldValues[field] = current[field];
      newValues[field] = updates[field];
    });

    await tx.insert(auditLogs).values({
      organization_id: current.organization_id || null,
      entity_type: getEntityType(table._.name),
      entity_id: newVersion.id,
      action: 'update',
      performed_by: performedBy,
      performed_by_staff: performedByStaff,
      old_values: oldValues,
      new_values: newValues,
      changed_fields: changedFields,
      ip_address: ipAddress,
      user_agent: userAgent,
      metadata,
    });

    return newVersion;
  });
}

/**
 * Hole komplette Historie einer Entität (SCD Type 2)
 */
export async function getEntityHistory({
  table,
  entityId,
}: {
  table: any;
  entityId: string;
}) {
  // Finde alle Versionen dieses Datensatzes
  const versions: any[] = [];
  let currentId = entityId;

  while (currentId) {
    const version = await db.query[table._.name].findFirst({
      where: eq(table.id, currentId),
    });

    if (!version) break;

    versions.push(version);

    // Gehe zur nächsten historischen Version
    currentId = version.previous_version_id;
  }

  return versions.sort((a, b) =>
    new Date(b.valid_from).getTime() - new Date(a.valid_from).getTime()
  );
}

/**
 * Hole aktuelle Version eines Datensatzes (für SCD Type 2 Tabellen)
 */
export async function getCurrentVersion({
  table,
  originalId,
}: {
  table: any;
  originalId: string;
}) {
  // Finde die neueste Version
  let currentId = originalId;
  let current = null;

  while (currentId) {
    const version = await db.query[table._.name].findFirst({
      where: eq(table.id, currentId),
    });

    if (!version) break;

    if (version.is_current) {
      current = version;
      break;
    }

    // Suche nach Versionen, die auf diese referenzieren
    const newer = await db.query[table._.name].findFirst({
      where: eq(table.previous_version_id, currentId),
    });

    if (!newer) {
      current = version;
      break;
    }

    currentId = newer.id;
  }

  return current;
}

/**
 * Beispiel: Staff-Adresse mit SCD Type 2 updaten
 */
export async function updateStaffAddress({
  addressId,
  updates,
  performedBy,
  performedByStaff,
  ipAddress,
  userAgent,
}: {
  addressId: string;
  updates: {
    street?: string;
    house_number?: string;
    postal_code?: string;
    city?: string;
    state?: string;
    country?: string;
  };
  performedBy?: string;
  performedByStaff?: string;
  ipAddress?: string;
  userAgent?: string;
}) {
  return await createNewVersion({
    table: staffAddresses,
    currentId: addressId,
    updates,
    performedBy,
    performedByStaff,
    ipAddress,
    userAgent,
  });
}

// ============================================================================
// UNIVERSAL AUDIT LOGGING FUNCTIONS
// ============================================================================

/**
 * Universelles Audit-Logging für alle CRUD-Operationen
 */
export async function logAuditEvent({
  organizationId,
  entityType,
  entityId,
  action,
  performedBy,
  performedByStaff,
  oldValues,
  newValues,
  changedFields,
  ipAddress,
  userAgent,
  metadata,
}: {
  organizationId?: string;
  entityType: 'organization' | 'user' | 'role' | 'staff' | 'shift' | 'shift_assignment';
  entityId: string;
  action: 'create' | 'update' | 'delete' | 'status_change';
  performedBy?: string;
  performedByStaff?: string;
  oldValues?: Record<string, any>;
  newValues?: Record<string, any>;
  changedFields?: string[];
  ipAddress?: string;
  userAgent?: string;
  metadata?: Record<string, any>;
}) {
  return await db.insert(auditLogs).values({
    organization_id: organizationId,
    entity_type: entityType,
    entity_id: entityId,
    action,
    performed_by: performedBy,
    performed_by_staff: performedByStaff,
    old_values: oldValues,
    new_values: newValues,
    changed_fields: changedFields,
    ip_address: ipAddress,
    user_agent: userAgent,
    metadata,
  });
}

/**
 * Wrapper für CREATE-Operationen mit automatischem Audit-Log
 */
export async function createWithAudit<T extends Record<string, any>>({
  table,
  values,
  entityType,
  performedBy,
  performedByStaff,
  ipAddress,
  userAgent,
  metadata,
}: {
  table: any;
  values: T;
  entityType: 'organization' | 'user' | 'role' | 'staff' | 'shift' | 'shift_assignment';
  performedBy?: string;
  performedByStaff?: string;
  ipAddress?: string;
  userAgent?: string;
  metadata?: Record<string, any>;
}) {
  return await db.transaction(async (tx) => {
    const [created] = await tx.insert(table).values(values).returning();

    await tx.insert(auditLogs).values({
      organization_id: created.organization_id || null,
      entity_type: entityType,
      entity_id: created.id,
      action: 'create',
      performed_by: performedBy,
      performed_by_staff: performedByStaff,
      new_values: created,
      ip_address: ipAddress,
      user_agent: userAgent,
      metadata,
    });

    return created;
  });
}

/**
 * Wrapper für UPDATE-Operationen mit automatischem Audit-Log
 */
export async function updateWithAudit<T extends Record<string, any>>({
  table,
  id,
  updates,
  entityType,
  performedBy,
  performedByStaff,
  ipAddress,
  userAgent,
  metadata,
}: {
  table: any;
  id: string;
  updates: Partial<T>;
  entityType: 'organization' | 'user' | 'role' | 'staff' | 'shift' | 'shift_assignment';
  performedBy?: string;
  performedByStaff?: string;
  ipAddress?: string;
  userAgent?: string;
  metadata?: Record<string, any>;
}) {
  return await db.transaction(async (tx) => {
    // Hole alte Werte
    const oldRecord = await tx.query[table._.name].findFirst({
      where: eq(table.id, id),
    });

    if (!oldRecord) {
      throw new Error('Record not found');
    }

    // Update ausführen
    const [updated] = await tx
      .update(table)
      .set({ ...updates, updated_at: new Date() })
      .where(eq(table.id, id))
      .returning();

    // Ermittle geänderte Felder
    const changedFields = Object.keys(updates);
    const oldValues: Record<string, any> = {};
    const newValues: Record<string, any> = {};

    changedFields.forEach((field) => {
      oldValues[field] = oldRecord[field];
      newValues[field] = updates[field];
    });

    // Log erstellen
    await tx.insert(auditLogs).values({
      organization_id: updated.organization_id || null,
      entity_type: entityType,
      entity_id: id,
      action: 'update',
      performed_by: performedBy,
      performed_by_staff: performedByStaff,
      old_values: oldValues,
      new_values: newValues,
      changed_fields: changedFields,
      ip_address: ipAddress,
      user_agent: userAgent,
      metadata,
    });

    return updated;
  });
}

/**
 * Wrapper für DELETE-Operationen mit automatischem Audit-Log
 */
export async function deleteWithAudit({
  table,
  id,
  entityType,
  performedBy,
  performedByStaff,
  ipAddress,
  userAgent,
  metadata,
}: {
  table: any;
  id: string;
  entityType: 'organization' | 'user' | 'role' | 'staff' | 'shift' | 'shift_assignment';
  performedBy?: string;
  performedByStaff?: string;
  ipAddress?: string;
  userAgent?: string;
  metadata?: Record<string, any>;
}) {
  return await db.transaction(async (tx) => {
    // Hole Daten vor dem Löschen
    const record = await tx.query[table._.name].findFirst({
      where: eq(table.id, id),
    });

    if (!record) {
      throw new Error('Record not found');
    }

    // Log erstellen VOR dem Löschen
    await tx.insert(auditLogs).values({
      organization_id: record.organization_id || null,
      entity_type: entityType,
      entity_id: id,
      action: 'delete',
      performed_by: performedBy,
      performed_by_staff: performedByStaff,
      old_values: record,
      ip_address: ipAddress,
      user_agent: userAgent,
      metadata,
    });

    // Löschen
    await tx.delete(table).where(eq(table.id, id));

    return record;
  });
}

/**
 * Hole Audit-Logs für eine bestimmte Entität
 */
export async function getAuditLogsForEntity({
  entityType,
  entityId,
  limit = 50,
}: {
  entityType: 'organization' | 'user' | 'role' | 'staff' | 'shift' | 'shift_assignment';
  entityId: string;
  limit?: number;
}) {
  return await db.query.auditLogs.findMany({
    where: and(
      eq(auditLogs.entity_type, entityType),
      eq(auditLogs.entity_id, entityId)
    ),
    orderBy: (logs, { desc }) => [desc(logs.created_at)],
    limit,
    with: {
      performedByUser: {
        columns: {
          id: true,
          name: true,
          email: true,
        },
      },
      performedByStaffMember: {
        columns: {
          id: true,
          name: true,
          email: true,
        },
      },
    },
  });
}

/**
 * Hole alle Audit-Logs für eine Organisation in einem Zeitraum
 */
export async function getOrganizationAuditLogs({
  organizationId,
  startDate,
  endDate,
  entityType,
  action,
  limit = 100,
}: {
  organizationId: string;
  startDate?: Date;
  endDate?: Date;
  entityType?: 'organization' | 'user' | 'role' | 'staff' | 'shift' | 'shift_assignment';
  action?: 'create' | 'update' | 'delete' | 'status_change';
  limit?: number;
}) {
  const conditions = [eq(auditLogs.organization_id, organizationId)];

  if (entityType) {
    conditions.push(eq(auditLogs.entity_type, entityType));
  }

  if (action) {
    conditions.push(eq(auditLogs.action, action));
  }

  return await db.query.auditLogs.findMany({
    where: and(...conditions),
    orderBy: (logs, { desc }) => [desc(logs.created_at)],
    limit,
    with: {
      performedByUser: true,
      performedByStaffMember: true,
    },
  });
}

// ============================================================================
// SHIFT ASSIGNMENT SPECIFIC FUNCTIONS
// ============================================================================

/**
 * Helper-Funktion zum Aktualisieren des Assignment-Status mit automatischem Logging
 */
export async function updateAssignmentStatus({
  assignmentId,
  newStatus,
  message,
  changedBy,
  changedByStaff,
  metadata,
  ipAddress,
  userAgent,
}: {
  assignmentId: string;
  newStatus: 'pending' | 'accepted' | 'declined';
  message?: string;
  changedBy?: string; // User ID (Manager)
  changedByStaff?: string; // Staff ID
  metadata?: Record<string, any>;
  ipAddress?: string;
  userAgent?: string;
}) {
  // Hole aktuellen Status
  const currentAssignment = await db.query.shiftAssignments.findFirst({
    where: eq(shiftAssignments.id, assignmentId),
  });

  if (!currentAssignment) {
    throw new Error('Assignment not found');
  }

  const previousStatus = currentAssignment.response_status;

  // Nur updaten wenn sich der Status tatsächlich ändert
  if (previousStatus === newStatus) {
    return currentAssignment;
  }

  // Transaction: Update Assignment, erstelle Assignment-Log und Audit-Log
  return await db.transaction(async (tx) => {
    // 1. Update Assignment
    const [updatedAssignment] = await tx
      .update(shiftAssignments)
      .set({
        response_status: newStatus,
        response_message: message,
        responded_at: new Date(),
        updated_at: new Date(),
      })
      .where(eq(shiftAssignments.id, assignmentId))
      .returning();

    // 2. Erstelle Assignment-spezifischen Log-Eintrag
    await tx.insert(shiftAssignmentLogs).values({
      assignment_id: assignmentId,
      previous_status: previousStatus,
      new_status: newStatus,
      changed_by: changedBy,
      changed_by_staff: changedByStaff,
      message,
      metadata,
    });

    // 3. Erstelle universellen Audit-Log-Eintrag
    await tx.insert(auditLogs).values({
      organization_id: null, // Wird über shift ermittelt wenn nötig
      entity_type: 'shift_assignment',
      entity_id: assignmentId,
      action: 'status_change',
      performed_by: changedBy,
      performed_by_staff: changedByStaff,
      old_values: { response_status: previousStatus },
      new_values: { response_status: newStatus },
      changed_fields: ['response_status'],
      ip_address: ipAddress,
      user_agent: userAgent,
      metadata,
    });

    return updatedAssignment;
  });
}

/**
 * Helper-Funktion zum Abrufen der kompletten Historie einer Zuweisung
 */
export async function getAssignmentHistory(assignmentId: string) {
  return await db.query.shiftAssignmentLogs.findMany({
    where: eq(shiftAssignmentLogs.assignment_id, assignmentId),
    orderBy: (logs, { desc }) => [desc(logs.created_at)],
    with: {
      changedByUser: {
        columns: {
          id: true,
          name: true,
          email: true,
        },
      },
      changedByStaffMember: {
        columns: {
          id: true,
          name: true,
          email: true,
        },
      },
    },
  });
}

/**
 * Helper-Funktion für Statistiken über Statusänderungen
 */
export async function getAssignmentStatistics(shiftId: string) {
  const logs = await db.query.shiftAssignmentLogs.findMany({
    where: (logs, { eq, and }) =>
      and(
        eq(logs.assignment_id, shiftId)
      ),
    with: {
      assignment: true,
    },
  });

  // Berechne Statistiken
  const acceptedCount = logs.filter((log) => log.new_status === 'accepted').length;
  const declinedCount = logs.filter((log) => log.new_status === 'declined').length;
  const changedByManagerCount = logs.filter((log) => log.changed_by !== null).length;
  const changedByStaffCount = logs.filter((log) => log.changed_by_staff !== null).length;

  return {
    totalChanges: logs.length,
    acceptedCount,
    declinedCount,
    changedByManagerCount,
    changedByStaffCount,
    logs,
  };
}

/**
 * Formatiere Log-Historie für Anzeige
 */
export function formatAssignmentHistory(
  logs: Awaited<ReturnType<typeof getAssignmentHistory>>
): string[] {
  return logs.map((log) => {
    const actor = log.changedByUser
      ? `Manager ${log.changedByUser.name}`
      : log.changedByStaffMember
      ? `Staff ${log.changedByStaffMember.name}`
      : 'System';

    const statusChange = log.previous_status
      ? `${log.previous_status} → ${log.new_status}`
      : `Status gesetzt: ${log.new_status}`;

    const timestamp = new Date(log.created_at).toLocaleString('de-DE');

    let line = `[${timestamp}] ${actor}: ${statusChange}`;

    if (log.message) {
      line += ` - "${log.message}"`;
    }

    return line;
  });
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Helper-Funktion um den Entity-Type aus dem Tabellennamen zu ermitteln
 */
function getEntityType(tableName: string): any {
  const mapping: Record<string, string> = {
    organizations: 'organization',
    users: 'user',
    roles: 'role',
    staff: 'staff',
    shifts: 'shift',
    shift_assignments: 'shift_assignment',
  };
  return mapping[tableName] || 'organization';
}
