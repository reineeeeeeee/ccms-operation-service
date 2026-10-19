// The four CCMS roles. There is no Citizen role in CCMS.
export const ROLES = Object.freeze({
  SUPER_ADMIN: 'super_admin',
  OFFICE_HEAD: 'office_head',
  OFFICE_STAFF: 'office_staff',
  EXECUTIVE: 'executive',
});

export const ROLE_LIST = Object.freeze(Object.values(ROLES));

export const ROLE_LABELS = Object.freeze({
  [ROLES.SUPER_ADMIN]: 'Super Admin',
  [ROLES.OFFICE_HEAD]: 'Office Head',
  [ROLES.OFFICE_STAFF]: 'Office Staff',
  [ROLES.EXECUTIVE]: 'Executive',
});

// Roles that must be bound to exactly one office.
export const OFFICE_BOUND_ROLES = Object.freeze([ROLES.OFFICE_HEAD, ROLES.OFFICE_STAFF]);

export function isOfficeBound(role) {
  return OFFICE_BOUND_ROLES.includes(role);
}

export function isValidRole(role) {
  return ROLE_LIST.includes(role);
}
