// Module x action permission matrix. Roles are templates; admins can fine-tune per user later.

// One module per page, in menu order (the Users page lists them in this order).
export const MODULES = [
  'dashboard',
  'accounts',
  'rules',
  'ruleTesting',
  'historicalJobs',
  'history',
  'destinations',
  'notifications',
  'syncHistory',
  'logs',
  'system',
  'users',
  'integrations',
  'settings',
] as const;
export type Module = (typeof MODULES)[number];

export const ACTIONS = ['view', 'create', 'edit', 'delete', 'execute'] as const;
export type Action = (typeof ACTIONS)[number];

export const ROLES = ['SUPER_ADMIN', 'ADMIN', 'OPERATOR', 'VIEWER'] as const;
export type Role = (typeof ROLES)[number];

export type PermissionSet = Partial<Record<Module, Action[]>>;

const all: Action[] = [...ACTIONS];

export const ROLE_TEMPLATES: Record<Role, PermissionSet> = {
  SUPER_ADMIN: Object.fromEntries(MODULES.map((m) => [m, all])) as PermissionSet,
  ADMIN: {
    dashboard: ['view'],
    accounts: all,
    rules: all,
    ruleTesting: ['view', 'execute'],
    historicalJobs: ['view', 'execute'],
    history: ['view', 'execute'],
    destinations: all,
    notifications: ['view'],
    syncHistory: ['view'],
    logs: ['view'],
    system: ['view'],
    integrations: ['view'],
    settings: ['view'],
  },
  OPERATOR: {
    dashboard: ['view'],
    accounts: ['view'],
    rules: ['view'],
    ruleTesting: ['view', 'execute'],
    historicalJobs: ['view', 'execute'],
    history: ['view', 'execute'],
    destinations: ['view'],
    notifications: ['view'],
    syncHistory: ['view'],
    logs: ['view'],
    system: ['view'],
  },
  VIEWER: {
    dashboard: ['view'],
    accounts: ['view'],
    rules: ['view'],
    history: ['view'],
    destinations: ['view'],
    notifications: ['view'],
    syncHistory: ['view'],
    system: ['view'],
  },
};

export function can(perms: PermissionSet, module: Module, action: Action): boolean {
  return perms[module]?.includes(action) ?? false;
}
