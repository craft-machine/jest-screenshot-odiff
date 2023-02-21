import chalk from "chalk";

import os from 'os';
import { existsSync, writeFileSync, mkdtempSync, copyFileSync } from "fs";

import { compare } from './odiff-sync';
import { getSnapshotPath, getReportPath, getReportDir } from "./filenames";
import { isJestTestConfiguration, MatcherResult } from "./jest";
import { sync as mkdirp } from "mkdirp";
import * as path from "path";
import { JestScreenshotConfiguration } from "./config";

const OS_TMP_DIR = os.tmpdir();

export interface ToMatchImageSnapshotParameters {
    /**
     * Can be used to override the path to which the snapshot image
     * will be written.
     */
    path?: string;
}

export interface ImageMatcherResult extends MatcherResult {
    changedRelative?: number;
    changedPixels?: number;
    testFileName?: string;
    snapshotNumber?: number;
}

/**
 * Performs the actual check for equality of two images.
 *
 * @param snapshotPath The image from the snapshot.
 * @param receivedPath The image received from the `expect(...)` call.
 * @param snapshotNumber The number of the snapshot in this test.
 * @param configuration The configuration of the call to `toMatchImageSnapshot`.
 *
 * @return A `MatcherResult` with `pass` and a message which can be handed to jest.
 */
function checkImages(
    snapshotPath: string,
    receivedPath: string,
    diffPath: string,
    snapshotNumber: number,
    configuration: JestScreenshotConfiguration,
): ImageMatcherResult {
    const {
        colorThreshold,
        detectAntialiasing,
        pixelThresholdAbsolute,
        pixelThresholdRelative,
    } = configuration;

    // Perform the actual image diff.
    const { match, reason, diffCount, diffPercentage } = compare(receivedPath, snapshotPath, diffPath, {
        antialiasing: detectAntialiasing,
        threshold: colorThreshold,
        outputDiffMask: true,
    });

    const expected = `stored snapshot ${snapshotNumber}`;
    const preamble = `${chalk.red("Received value")} does not match ${chalk.green(expected)}.`;

    if (typeof pixelThresholdAbsolute === "number" && diffCount > pixelThresholdAbsolute) {
        return {
            pass: false,
            message: () =>
                `${preamble}\n\n` +
                `Expected less than ${chalk.green(`${pixelThresholdAbsolute} pixels`)} to have changed, ` +
                `but ${chalk.red(`${diffCount} pixels`)} changed.`,
            changedRelative: diffPercentage,
            changedPixels: diffCount,
        };
    }

    if (typeof pixelThresholdRelative === "number" && diffPercentage > pixelThresholdRelative) {
        const percentThreshold = (pixelThresholdRelative * 100).toFixed(2);
        const percentChanged = (diffPercentage * 100).toFixed(2);
        return {
            pass: false,
            message: () =>
                `${preamble}\n\n` +
                `Expected less than ${chalk.green(`${percentThreshold}%`)} of the pixels to have changed, ` +
                `but ${chalk.red(`${percentChanged}%`)} of the pixels changed.`,
            changedRelative: diffPercentage,
            changedPixels: diffCount,
        };
    }

    if (match === false && reason === 'layout-diff') {
        return {
            pass: false,
            message: () =>
                `${preamble}\n\n` +
                `Expected snapshot dimensions to be the same, but dimensions changed.`,
            changedRelative: diffPercentage,
            changedPixels: diffCount,
        };
    }

    return { pass: true };
}

/**
 * A matcher for jest with compares a PNG image to a stored snapshot. Behaves similar to `.toMatchSnapshot()`.
 *
 * @param received The buffer from the call to `expect(...)`.
 * @param configuration The configuration object provided when initializing this library
 *     with a call to `jestScreenshot`.
 * @param parameters Optional parameters provided to the call of `expect(...).toMatchImageSnapshot(...)`.
 *
 * @return A `MatcherResult` usable by jest.
 */
export function toMatchImageSnapshot(
    received: Buffer,
    configuration: JestScreenshotConfiguration,
    parameters: ToMatchImageSnapshotParameters = {},
): MatcherResult {
    const { snapshotsDir, reportDir, noReport } = configuration;
    // Check whether `this` is really the expected Jest configuration.
    if (!isJestTestConfiguration(this)) {
        throw new Error("Jest: Attempted to call `.toMatchImageSnapshot()` outside of Jest context.");
    }
    const { testPath, currentTestName, isNot } = this;
    if (isNot) {
        throw new Error("Jest: `.not` cannot be used with `.toMatchImageSnapshot()`.");
    }
    let { snapshotState } = this;
    const { _updateSnapshot } = snapshotState;
    const snapshotNumber = (snapshotState._counters.get(currentTestName) || 0) as number + 1;
    snapshotState._counters.set(currentTestName, snapshotNumber);
    const snapshotPath = typeof parameters.path === "string" ?
        parameters.path :
        getSnapshotPath(testPath, currentTestName, snapshotState, snapshotsDir);
    const reportPath = getReportPath(testPath, currentTestName, snapshotState, reportDir);
    // Create the path to store the snapshots in.
    mkdirp(path.dirname(snapshotPath));
    // The image did not yet exist.
    if (!existsSync(snapshotPath)) {
        // If the user specified `-u`, or was running in interactive mode, write the new
        // snapshot to disk and let the test pass.
        if (_updateSnapshot === "new" || _updateSnapshot === "all") {
            snapshotState.added++;
            writeFileSync(snapshotPath, received);
            return { pass: true };
        }
        // Otherwise fail due to missing snapshot.
        return {
            pass: false,
            message: () => `New snapshot was ${chalk.red("not written")}. ` +
                `The update flag must be explicitly passed to write a new snapshot.\n\n` +
                `This is likely because this test is run in a continuous integration (CI) environment ` +
                `in which snapshots are not written by default.`,
        };
    }

    const tmpComparisonDir = mkdtempSync(path.join(OS_TMP_DIR, 'jest-screenshot-odiff-'));
    const tmpReceivedPath = path.join(tmpComparisonDir, 'received.png');
    const tmpDiffPath = path.join(tmpComparisonDir, 'diff.png');

    writeFileSync(tmpReceivedPath, received);

    // Perform the actual diff of the images.
    const {
        pass,
        message,
        changedRelative,
        changedPixels,
    } = checkImages(snapshotPath, tmpReceivedPath, tmpDiffPath, snapshotNumber, configuration);

    if (!pass) {
        if (_updateSnapshot === "all") {
            snapshotState.updated++;
            writeFileSync(snapshotPath, received);
            return { pass: true };
        }
        if (!noReport) {
            mkdirp(reportPath);

            const receivedPath = path.join(reportPath, "received.png");
            const diffPath = path.join(reportPath, "diff.png");
            const snapshotPathReport = path.join(reportPath, "snapshot.png");

            writeFileSync(receivedPath, received);
            copyFileSync(tmpDiffPath, diffPath);
            copyFileSync(snapshotPath, snapshotPathReport);
            writeFileSync(
                path.join(reportPath, "info.json"),
                JSON.stringify({
                    testName: currentTestName,
                    message: message(),
                    changedRelative,
                    changedPixels,
                    testFileName: path.relative(process.cwd(), testPath),
                    snapshotNumber,
                    receivedPath: path.relative(getReportDir(reportDir), receivedPath),
                    diffPath: path.relative(getReportDir(reportDir), diffPath),
                    snapshotPath: path.relative(getReportDir(reportDir), snapshotPathReport),
                })
            );
        }
    }

    return { pass, message };
}
