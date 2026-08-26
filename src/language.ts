import { EXTENSION_LANGUAGE_MAP } from './types.js';

/**
 * Resolve language from file extension
 */
export function resolveLanguage(entity: string): string {
  // Extract extension from file path
  const lastDot = entity.lastIndexOf('.');
  if (lastDot === -1) return 'Unknown';
  
  const ext = entity.slice(lastDot).toLowerCase();
  return EXTENSION_LANGUAGE_MAP[ext] || 'Unknown';
}
