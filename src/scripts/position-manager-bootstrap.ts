import { installPunycodeWarningFilter } from './install-punycode-warning-filter.js';

installPunycodeWarningFilter();

await import(new URL('./position-manager.ts', import.meta.url).href);