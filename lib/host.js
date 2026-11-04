/**
 * Resolve Host-provided packages (`@deepseek-ai/dsh-*`) without assuming where
 * the plugin physically lives.
 *
 * A plugin installed as a copy resolves them by walking up to
 * `<profile>/node_modules/@deepseek-ai`. A plugin installed as a link/junction
 * resolves against its *real* directory instead, where no such tree exists —
 * so try the bare specifier first, then the profile trees, then the CLI's own
 * `node_modules`. Same order DSH itself uses, just made explicit.
 */

import { join } from 'node:path';
import { homedir } from 'node:os';
import { pathToFileURL } from 'node:url';

const cache = new Map();

export function dshHomePath() {
    const configured = process.env.DSH_HOME;
    if (typeof configured === 'string' && configured.trim() !== '') return configured.trim();
    return join(homedir(), '.dsh');
}

export function hostModuleCandidates(specifier) {
    const dshHome = dshHomePath();
    const home = homedir();
    const [, ...rest] = specifier.split('/');
    const tail = rest.join('/');
    return [
        specifier,
        pathToFileURL(join(dshHome, 'profiles', 'node_modules', specifier, 'lib', 'index.js')).href,
        pathToFileURL(join(dshHome, 'profiles', 'web', 'node_modules', specifier, 'lib', 'index.js')).href,
        pathToFileURL(join(home, 'AppData', 'Roaming', 'npm', 'node_modules', '@deepseek-ai', 'dsh', 'node_modules', specifier, 'lib', 'index.js')).href,
    ].filter(Boolean);
}

/**
 * Import one Host package.
 * @param {string} specifier e.g. `@deepseek-ai/dsh-tools`
 * @returns {Promise<object>}
 */
export async function loadHostModule(specifier) {
    if (cache.has(specifier)) return cache.get(specifier);
    const failures = [];
    for (const candidate of hostModuleCandidates(specifier)) {
        try {
            const loaded = await import(candidate);
            cache.set(specifier, loaded);
            return loaded;
        } catch (error) {
            failures.push(`${candidate}: ${error instanceof Error ? error.message.split('\n')[0] : String(error)}`);
        }
    }
    throw new Error(`找不到宿主包 ${specifier}：\n${failures.join('\n')}`);
}
