import { installPunycodeWarningFilter } from './install-punycode-warning-filter.js';

installPunycodeWarningFilter();

await import(new URL('./dashboard.ts', import.meta.url).href);