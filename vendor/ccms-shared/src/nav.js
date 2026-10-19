// Role-based navigation. Pure data (no React) so every service's app shell can use it.
// Each service is a separate app, so links are plain page URLs served through the API gateway.
import { ROLES } from './roles.js';

export const LANDING_BY_ROLE = Object.freeze({
  [ROLES.SUPER_ADMIN]: '/accounts',
  [ROLES.OFFICE_HEAD]: '/office',
  [ROLES.OFFICE_STAFF]: '/office',
  [ROLES.EXECUTIVE]: '/campus',
});

// Home is the public landing page (the page citizens see); it is reachable from every signed-in role.
const HOME = { section: 'Main', label: 'Home', href: '/' };

// Services and Calendar are reference pages every role can open; write controls are Super Admin only (enforced by the APIs).
const SERVICES = { section: 'Reference', label: 'Services', href: '/services' };
const CALENDAR = { section: 'Reference', label: 'Calendar', href: '/calendar' };

export const NAV_BY_ROLE = Object.freeze({
  [ROLES.SUPER_ADMIN]: [
    HOME,
    { section: 'Administration', label: 'Accounts', href: '/accounts' },
    { section: 'Administration', label: 'Offices', href: '/offices' },
    SERVICES,
    CALENDAR,
  ],
  [ROLES.OFFICE_HEAD]: [HOME, { section: 'Main', label: 'Office Home', href: '/office' }, SERVICES, CALENDAR],
  [ROLES.OFFICE_STAFF]: [HOME, { section: 'Main', label: 'Office Home', href: '/office' }, SERVICES, CALENDAR],
  [ROLES.EXECUTIVE]: [HOME, { section: 'Main', label: 'Campus Home', href: '/campus' }, SERVICES, CALENDAR],
});

export function navForRole(role) {
  return NAV_BY_ROLE[role] ?? [];
}

export function landingForRole(role) {
  return LANDING_BY_ROLE[role] ?? '/login';
}

// Pages a role may open, used by the app shell to keep a role off other roles' pages.
export function canOpenPage(role, pathname) {
  return navForRole(role).some((item) => pathname === item.href || pathname.startsWith(`${item.href}/`));
}
