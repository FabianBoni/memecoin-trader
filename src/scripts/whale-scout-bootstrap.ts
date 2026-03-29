import { installPunycodeWarningFilter } from './install-punycode-warning-filter.js';

installPunycodeWarningFilter();

await import(new URL('./whale-scout.ts', import.meta.url).href);