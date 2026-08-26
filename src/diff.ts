import { DiffResult, MAX_DIFF_LINES } from './types.js';

/**
 * Calculate diff for write operation
 * For write: all lines are additions (new file or overwritten)
 * Returns null if file exceeds MAX_DIFF_LINES
 */
export function calculateWriteDiff(content: string): DiffResult | null {
  const lines = content.split('\n').length;
  if (lines > MAX_DIFF_LINES) return null;
  return {
    lines,
    lineAdditions: lines,
    lineDeletions: 0,
  };
}

/**
 * Calculate diff for edit operation
 * Compare old_string vs new_string line counts
 * Returns null if result exceeds MAX_DIFF_LINES
 */
export function calculateEditDiff(oldString: string, newString: string): DiffResult | null {
  const oldLines = oldString.split('\n').length;
  const newLines = newString.split('\n').length;
  if (newLines > MAX_DIFF_LINES) return null;
  return {
    lines: newLines,
    lineAdditions: Math.max(0, newLines - oldLines),
    lineDeletions: Math.max(0, oldLines - newLines),
  };
}
