import { compare as odiffCompare } from 'odiff-bin';

import { execSync } from 'child_process';
import path from 'path';
import os from 'os';

export type OdiffArguents = Parameters<typeof odiffCompare>;
export type OdiffReturnType = {
  match: boolean;
  reason?: 'layout-diff' | 'pixel-diff';
  diffCount?: number;
  diffPercentage?: number;
};

/**
 * Odiff has async node bindings that are not compatible with jest's
 * sync matcher style used by jest-screenshot, so we're invoking the
 * binary directly with "execSync" here.
 */
export const compare: (...args: OdiffArguents) => OdiffReturnType = (a, b, diff, options) => {
  try {
    const odiffPath = require.resolve('odiff-bin');
    const odiffBinPath = path.resolve(odiffPath, '..', 'bin', 'odiff');
    const args = ['--parsable-stdout'];

    if (options.antialiasing) {
      args.push('--antialiasing');
    }

    if (options.diffColor) {
      args.push(`--diff-color=${options.diffColor}`);
    }

    if (options.threshold) {
      args.push(`--threshold=${options.threshold}`);
    }

    if (options.outputDiffMask) {
      args.push('--diff-mask');
    }

    execSync(`${odiffBinPath} ${a} ${b} ${diff} ${args.join(' ')}`, {
      encoding: 'utf8',
    });

    // Exit code 0 means images are identical
    return { match: true, diffCount: 0, diffPercentage: 0 };
  } catch(e) {
    if (e.status) {
      // Expected error codes for image diff
      if (e.status === 21) {
        return { match: false, reason: 'layout-diff', diffCount: 0, diffPercentage: 0 };
      }

      if (e.status === 22) {
        const [diffCount = '0', diffPercentage = '0'] = (e.output ?? []).join('').trim().split(';');
        return { match: false, reason: 'pixel-diff', diffCount: parseInt(diffCount), diffPercentage: parseFloat(diffPercentage) / 100 };
      }
    }

    // Otherwise, the error is something unexpected
    process.stderr.write(`Error executing odiff image comparison in "@craft.co/jest-screenshot-odiff"`);

    if (e.status) {
      process.stderr.write(`Exit code: ${e.status}`);
    }

    if (e.output) {
      process.stderr.write(e.output.join(os.EOL));
    }

    throw e;
  }
}