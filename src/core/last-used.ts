/**
 * How far a stored "last used" may lag the real one — a member's token and an
 * API key alike.
 *
 * Every authenticated request would otherwise be a row write, on a machine
 * whose disk is an SD card, and "last used" is read by a person in units of
 * days, so an hour's resolution is plenty. One number for both, because two
 * copies of it were already two places for the next change to land in only
 * one.
 */
export const LAST_USED_RESOLUTION_MS = 60 * 60 * 1000;

/** Whether a "last used" stored at `writtenAt` is due to be written again. */
export function lastUsedDue(writtenAt: number, now: number): boolean {
  return now - writtenAt > LAST_USED_RESOLUTION_MS;
}
