import { pgTable, uuid, varchar, text, timestamp, boolean, pgEnum, json } from 'drizzle-orm/pg-core';
import { relations } from 'drizzle-orm';

// Enums
export const shiftStatusEnum = pgEnum('shift_status', ['draft', 'published', 'confirmed', 'cancelled']);
export const responseStatusEnum = pgEnum('response_status', ['pending', 'accepted', 'declined']);
export const auditActionEnum = pgEnum('audit_action', ['create', 'update', 'delete', 'status_change']);
export const entityTypeEnum = pgEnum('entity_type', [
  'organization',
  'user',
  'role',
  'staff',
  'shift',
  'shift_assignment',
]);

// Organizations/Companies - Die Organisation (Band, Restaurant, Firma, etc.)
export const organizations = pgTable('organizations', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: varchar('name', { length: 255 }).notNull(),
  type: varchar('type', { length: 100 }), // z.B. 'band', 'restaurant', 'event_agency', 'catering', etc.
  description: text('description'),
  settings: json('settings'), // Flexible Einstellungen je nach Branche
  // SCD Type 2 Felder
  valid_from: timestamp('valid_from').defaultNow().notNull(),
  valid_to: timestamp('valid_to'), // NULL = aktuell gültig
  is_current: boolean('is_current').default(true).notNull(),
  previous_version_id: uuid('previous_version_id').references((): any => organizations.id),
  created_at: timestamp('created_at').defaultNow().notNull(),
  updated_at: timestamp('updated_at').defaultNow().notNull(),
});

// Users Tabelle - Manager/Organisatoren
export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  organization_id: uuid('organization_id').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
  email: varchar('email', { length: 255 }).notNull().unique(),
  name: varchar('name', { length: 255 }).notNull(),
  password_hash: text('password_hash').notNull(),
  role: varchar('role', { length: 50 }).default('manager').notNull(), // manager, admin, viewer
  // SCD Type 2 Felder
  valid_from: timestamp('valid_from').defaultNow().notNull(),
  valid_to: timestamp('valid_to'),
  is_current: boolean('is_current').default(true).notNull(),
  previous_version_id: uuid('previous_version_id').references((): any => users.id),
  created_at: timestamp('created_at').defaultNow().notNull(),
  updated_at: timestamp('updated_at').defaultNow().notNull(),
});

// Roles/Positions - Flexible Rollen/Positionen je nach Branche
export const roles = pgTable('roles', {
  id: uuid('id').primaryKey().defaultRandom(),
  organization_id: uuid('organization_id').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
  name: varchar('name', { length: 100 }).notNull(), // z.B. 'Kellner', 'Koch', 'Gitarrist', 'Barkeeper'
  description: text('description'),
  color: varchar('color', { length: 7 }), // Hex-Farbcode für UI
  is_active: boolean('is_active').default(true).notNull(),
  // SCD Type 2 Felder
  valid_from: timestamp('valid_from').defaultNow().notNull(),
  valid_to: timestamp('valid_to'),
  is_current: boolean('is_current').default(true).notNull(),
  previous_version_id: uuid('previous_version_id').references((): any => roles.id),
  created_at: timestamp('created_at').defaultNow().notNull(),
  updated_at: timestamp('updated_at').defaultNow().notNull(),
});

// Staff/Employees - Das Personal (generisch für alle Branchen)
export const staff = pgTable('staff', {
  id: uuid('id').primaryKey().defaultRandom(),
  organization_id: uuid('organization_id').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
  name: varchar('name', { length: 255 }).notNull(),
  email: varchar('email', { length: 255 }).notNull(),
  phone: varchar('phone', { length: 50 }),
  primary_role_id: uuid('primary_role_id').references(() => roles.id, { onDelete: 'set null' }),
  notes: text('notes'), // Zusätzliche Notizen
  metadata: json('metadata'), // Flexible Daten wie Zertifikate, Skills, etc.
  is_active: boolean('is_active').default(true).notNull(),
  // SCD Type 2 Felder
  valid_from: timestamp('valid_from').defaultNow().notNull(),
  valid_to: timestamp('valid_to'),
  is_current: boolean('is_current').default(true).notNull(),
  previous_version_id: uuid('previous_version_id').references((): any => staff.id),
  created_at: timestamp('created_at').defaultNow().notNull(),
  updated_at: timestamp('updated_at').defaultNow().notNull(),
});

// Staff Addresses - SCD Type 2 für Adressen
export const staffAddresses = pgTable('staff_addresses', {
  id: uuid('id').primaryKey().defaultRandom(),
  staff_id: uuid('staff_id').notNull().references(() => staff.id, { onDelete: 'cascade' }),
  street: varchar('street', { length: 255 }),
  house_number: varchar('house_number', { length: 20 }),
  postal_code: varchar('postal_code', { length: 20 }),
  city: varchar('city', { length: 100 }),
  state: varchar('state', { length: 100 }),
  country: varchar('country', { length: 100 }),
  address_type: varchar('address_type', { length: 50 }).default('primary'), // primary, billing, shipping
  // SCD Type 2 Felder
  valid_from: timestamp('valid_from').defaultNow().notNull(),
  valid_to: timestamp('valid_to'),
  is_current: boolean('is_current').default(true).notNull(),
  previous_version_id: uuid('previous_version_id').references((): any => staffAddresses.id),
  created_at: timestamp('created_at').defaultNow().notNull(),
  updated_at: timestamp('updated_at').defaultNow().notNull(),
});

// Staff Roles - Mehrere Rollen pro Mitarbeiter möglich
export const staffRoles = pgTable('staff_roles', {
  id: uuid('id').primaryKey().defaultRandom(),
  staff_id: uuid('staff_id').notNull().references(() => staff.id, { onDelete: 'cascade' }),
  role_id: uuid('role_id').notNull().references(() => roles.id, { onDelete: 'cascade' }),
  created_at: timestamp('created_at').defaultNow().notNull(),
});

// Shifts - Die Schichten/Events/Aufträge
export const shifts = pgTable('shifts', {
  id: uuid('id').primaryKey().defaultRandom(),
  organization_id: uuid('organization_id').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
  created_by: uuid('created_by').notNull().references(() => users.id, { onDelete: 'cascade' }),
  title: varchar('title', { length: 255 }).notNull(),
  description: text('description'),
  location: varchar('location', { length: 255 }), // Einsatzort
  address: text('address'),
  shift_date: timestamp('shift_date').notNull(),
  start_time: timestamp('start_time').notNull(),
  end_time: timestamp('end_time').notNull(),
  compensation: varchar('compensation', { length: 100 }), // Bezahlung/Gage
  status: shiftStatusEnum('status').default('draft').notNull(),
  required_staff_count: varchar('required_staff_count', { length: 50 }), // z.B. "2 Kellner, 1 Koch"
  notes: text('notes'),
  metadata: json('metadata'), // Flexible Zusatzdaten
  // SCD Type 2 Felder
  valid_from: timestamp('valid_from').defaultNow().notNull(),
  valid_to: timestamp('valid_to'),
  is_current: boolean('is_current').default(true).notNull(),
  previous_version_id: uuid('previous_version_id').references((): any => shifts.id),
  created_at: timestamp('created_at').defaultNow().notNull(),
  updated_at: timestamp('updated_at').defaultNow().notNull(),
});

// Shift Assignments - Verknüpfung zwischen Schichten und Personal
export const shiftAssignments = pgTable('shift_assignments', {
  id: uuid('id').primaryKey().defaultRandom(),
  shift_id: uuid('shift_id').notNull().references(() => shifts.id, { onDelete: 'cascade' }),
  staff_id: uuid('staff_id').notNull().references(() => staff.id, { onDelete: 'cascade' }),
  role_id: uuid('role_id').references(() => roles.id, { onDelete: 'set null' }), // In welcher Rolle wird die Person eingeteilt
  response_status: responseStatusEnum('response_status').default('pending').notNull(),
  response_message: text('response_message'),
  invited_at: timestamp('invited_at').defaultNow().notNull(),
  responded_at: timestamp('responded_at'),
  email_sent_at: timestamp('email_sent_at'),
  created_at: timestamp('created_at').defaultNow().notNull(),
  updated_at: timestamp('updated_at').defaultNow().notNull(),
});

// Shift Assignment Logs - Protokoll aller Statusänderungen
export const shiftAssignmentLogs = pgTable('shift_assignment_logs', {
  id: uuid('id').primaryKey().defaultRandom(),
  assignment_id: uuid('assignment_id').notNull().references(() => shiftAssignments.id, { onDelete: 'cascade' }),
  previous_status: responseStatusEnum('previous_status'),
  new_status: responseStatusEnum('new_status').notNull(),
  changed_by: uuid('changed_by').references(() => users.id, { onDelete: 'set null' }), // Wer hat die Änderung vorgenommen (Manager oder Staff selbst)
  changed_by_staff: uuid('changed_by_staff').references(() => staff.id, { onDelete: 'set null' }), // Falls Staff die Änderung vorgenommen hat
  message: text('message'), // Optional: Nachricht zur Statusänderung
  metadata: json('metadata'), // Zusätzliche Informationen (z.B. IP-Adresse, User-Agent)
  created_at: timestamp('created_at').defaultNow().notNull(),
});

// Universal Audit Log - Zentrale Audit-Tabelle für alle Entitäten
export const auditLogs = pgTable('audit_logs', {
  id: uuid('id').primaryKey().defaultRandom(),
  organization_id: uuid('organization_id').references(() => organizations.id, { onDelete: 'cascade' }),
  entity_type: entityTypeEnum('entity_type').notNull(),
  entity_id: uuid('entity_id').notNull(), // ID der betroffenen Entität
  action: auditActionEnum('action').notNull(),
  performed_by: uuid('performed_by').references(() => users.id, { onDelete: 'set null' }),
  performed_by_staff: uuid('performed_by_staff').references(() => staff.id, { onDelete: 'set null' }),
  old_values: json('old_values'), // Vorherige Werte (JSON)
  new_values: json('new_values'), // Neue Werte (JSON)
  changed_fields: json('changed_fields').$type<string[]>(), // Array der geänderten Felder
  ip_address: varchar('ip_address', { length: 45 }), // IPv4 oder IPv6
  user_agent: text('user_agent'),
  metadata: json('metadata'), // Zusätzliche Context-Informationen
  created_at: timestamp('created_at').defaultNow().notNull(),
});

// Relations definieren
export const organizationsRelations = relations(organizations, ({ many }) => ({
  users: many(users),
  staff: many(staff),
  roles: many(roles),
  shifts: many(shifts),
  auditLogs: many(auditLogs),
}));

export const usersRelations = relations(users, ({ one, many }) => ({
  organization: one(organizations, {
    fields: [users.organization_id],
    references: [organizations.id],
  }),
  shifts: many(shifts),
  assignmentLogs: many(shiftAssignmentLogs),
  auditLogs: many(auditLogs),
}));

export const rolesRelations = relations(roles, ({ one, many }) => ({
  organization: one(organizations, {
    fields: [roles.organization_id],
    references: [organizations.id],
  }),
  staffMembers: many(staff),
  staffRoles: many(staffRoles),
  shiftAssignments: many(shiftAssignments),
}));

export const staffRelations = relations(staff, ({ one, many }) => ({
  organization: one(organizations, {
    fields: [staff.organization_id],
    references: [organizations.id],
  }),
  primaryRole: one(roles, {
    fields: [staff.primary_role_id],
    references: [roles.id],
  }),
  roles: many(staffRoles),
  assignments: many(shiftAssignments),
  assignmentLogs: many(shiftAssignmentLogs),
  addresses: many(staffAddresses),
  auditLogs: many(auditLogs),
}));

export const staffAddressesRelations = relations(staffAddresses, ({ one }) => ({
  staff: one(staff, {
    fields: [staffAddresses.staff_id],
    references: [staff.id],
  }),
}));

export const staffRolesRelations = relations(staffRoles, ({ one }) => ({
  staff: one(staff, {
    fields: [staffRoles.staff_id],
    references: [staff.id],
  }),
  role: one(roles, {
    fields: [staffRoles.role_id],
    references: [roles.id],
  }),
}));

export const shiftsRelations = relations(shifts, ({ one, many }) => ({
  organization: one(organizations, {
    fields: [shifts.organization_id],
    references: [organizations.id],
  }),
  creator: one(users, {
    fields: [shifts.created_by],
    references: [users.id],
  }),
  assignments: many(shiftAssignments),
}));

export const shiftAssignmentsRelations = relations(shiftAssignments, ({ one, many }) => ({
  shift: one(shifts, {
    fields: [shiftAssignments.shift_id],
    references: [shifts.id],
  }),
  staff: one(staff, {
    fields: [shiftAssignments.staff_id],
    references: [staff.id],
  }),
  role: one(roles, {
    fields: [shiftAssignments.role_id],
    references: [roles.id],
  }),
  logs: many(shiftAssignmentLogs),
}));

export const shiftAssignmentLogsRelations = relations(shiftAssignmentLogs, ({ one }) => ({
  assignment: one(shiftAssignments, {
    fields: [shiftAssignmentLogs.assignment_id],
    references: [shiftAssignments.id],
  }),
  changedByUser: one(users, {
    fields: [shiftAssignmentLogs.changed_by],
    references: [users.id],
  }),
  changedByStaffMember: one(staff, {
    fields: [shiftAssignmentLogs.changed_by_staff],
    references: [staff.id],
  }),
}));

export const auditLogsRelations = relations(auditLogs, ({ one }) => ({
  organization: one(organizations, {
    fields: [auditLogs.organization_id],
    references: [organizations.id],
  }),
  performedByUser: one(users, {
    fields: [auditLogs.performed_by],
    references: [users.id],
  }),
  performedByStaffMember: one(staff, {
    fields: [auditLogs.performed_by],
    references: [staff.id],
  }),
}));
