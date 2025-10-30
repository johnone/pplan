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
      where: and(eq(table.id, currentId), eq(table.isCurrent, true)),
    });

    if (!current) {
      throw new Error('Current version not found');
    }

    const now = new Date();

    // 2. Markiere aktuelle Version als historisch
    await tx
      .update(table)
      .set({
        validTo: now,
        isCurrent: false,
        updatedAt: now,
      })
      .where(eq(table.id, currentId));

    // 3. Erstelle neue Version
    const [newVersion] = await tx
      .insert(table)
      .values({
        ...current,
        ...updates,
        id: undefined, // Neue UUID wird generiert
        previousVersionId: currentId,
        validFrom: now,
        validTo: null,
        isCurrent: true,
        createdAt: current.createdAt, // Behalte ursprüngliches Erstellungsdatum
        updatedAt: now,
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
      organizationId: current.organizationId || null,
      entityType: getEntityType(table._.name),
      entityId: newVersion.id,
      action: 'update',
      performedBy,
      performedByStaff,
      oldValues,
      newValues,
      changedFields,
      ipAddress,
      userAgent,
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
    currentId = version.previousVersionId;
  }

  return versions.sort((a, b) => 
    new Date(b.validFrom).getTime() - new Date(a.validFrom).getTime()
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

    if (version.isCurrent) {
      current = version;
      break;
    }

    // Suche nach Versionen, die auf diese referenzieren
    const newer = await db.query[table._.name].findFirst({
      where: eq(table.previousVersionId, currentId),
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
    houseNumber?: string;
    postalCode?: string;
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
      organizationId: created.organizationId || null,
      entityType,
      entityId: created.id,
      action: 'create',
      performedBy,
      performedByStaff,
      newValues: created,
      ipAddress,
      userAgent,
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
      .set({ ...updates, updatedAt: new Date() })
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
      organizationId: updated.organizationId || null,
      entityType,
      entityId: id,
      action: 'update',
      performedBy,
      performedByStaff,
      oldValues,
      newValues,
      changedFields,
      ipAddress,
      userAgent,
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
      organizationId: record.organizationId || null,
      entityType,
      entityId: id,
      action: 'delete',
      performedBy,
      performedByStaff,
      oldValues: record,
      ipAddress,
      userAgent,
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
      eq(auditLogs.entityType, entityType),
      eq(auditLogs.entityId, entityId)
    ),
    orderBy: (logs, { desc }) => [desc(logs.createdAt)],
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
  const conditions = [eq(auditLogs.organizationId, organizationId)];

  if (entityType) {
    conditions.push(eq(auditLogs.entityType, entityType));
  }

  if (action) {
    conditions.push(eq(auditLogs.action, action));
  }

  return await db.query.auditLogs.findMany({
    where: and(...conditions),
    orderBy: (logs, { desc }) => [desc(logs.createdAt)],
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

  const previousStatus = currentAssignment.responseStatus;

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
        responseStatus: newStatus,
        responseMessage: message,
        respondedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(shiftAssignments.id, assignmentId))
      .returning();

    // 2. Erstelle Assignment-spezifischen Log-Eintrag
    await tx.insert(shiftAssignmentLogs).values({
      assignmentId,
      previousStatus,
      newStatus,
      changedBy,
      changedByStaff,
      message,
      metadata,
    });

    // 3. Erstelle universellen Audit-Log-Eintrag
    await tx.insert(auditLogs).values({
      organizationId: null, // Wird über shift ermittelt wenn nötig
      entityType: 'shift_assignment',
      entityId: assignmentId,
      action: 'status_change',
      performedBy: changedBy,
      performedByStaff: changedByStaff,
      oldValues: { responseStatus: previousStatus },
      newValues: { responseStatus: newStatus },
      changedFields: ['responseStatus'],
      ipAddress,
      userAgent,
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
    where: eq(shiftAssignmentLogs.assignmentId, assignmentId),
    orderBy: (logs, { desc }) => [desc(logs.createdAt)],
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
        eq(logs.assignmentId, shiftId)
      ),
    with: {
      assignment: true,
    },
  });

  // Berechne Statistiken
  const acceptedCount = logs.filter((log) => log.newStatus === 'accepted').length;
  const declinedCount = logs.filter((log) => log.newStatus === 'declined').length;
  const changedByManagerCount = logs.filter((log) => log.changedBy !== null).length;
  const changedByStaffCount = logs.filter((log) => log.changedByStaff !== null).length;

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

    const statusChange = log.previousStatus
      ? `${log.previousStatus} → ${log.newStatus}`
      : `Status gesetzt: ${log.newStatus}`;

    const timestamp = new Date(log.createdAt).toLocaleString('de-DE');

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
