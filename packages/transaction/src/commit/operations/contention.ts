import { AbloError } from '../../errors.js';

/** A decision-lock refusal made no write; retry without changing the sealed request. */
export async function retryOperationContention<Result>(action: () => Promise<Result>): Promise<Result> {
  for (let attempt = 0; ; attempt++) {
    try { return await action(); }
    catch (error) {
      if (!(error instanceof AbloError) || error.code !== 'decision_contended' || attempt === 15) throw error;
      await new Promise((resolve) => setTimeout(resolve, 25 * (attempt + 1) + Math.floor(Math.random() * 25)));
    }
  }
}
