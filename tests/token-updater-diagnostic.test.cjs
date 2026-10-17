const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const extensionRoot = join(__dirname, '..', 'token-updater');
const manifest = JSON.parse(readFileSync(join(extensionRoot, 'manifest.json'), 'utf8'));
const source = readFileSync(join(extensionRoot, 'background.js'), 'utf8');
const diagnosticStart = source.indexOf('let nativeFlowDiagnosticActive = false;');
const diagnosticEnd = source.indexOf('async function closeTemporaryTab(', diagnosticStart);
assert.ok(diagnosticStart >= 0 && diagnosticEnd > diagnosticStart, 'Native diagnostic is missing');
const collectionStart = source.indexOf('function normalizeCookieDomain(');
const executable = `const FLOW_URL = 'https://flow.google.com/projects';\n`
    + source.slice(collectionStart, diagnosticEnd);

const cookie = (name, value) => ({ name, value, domain: '.google.com', path: '/', secure: true });
const originalCookies = [cookie('OSID', 'session-secret'), cookie('SID', 'account-secret')];

function hasCookiePermission(item, origins) {
    const scheme = item.secure ? 'https' : 'http';
    const domain = item.domain.replace(/^\./, '');
    return origins.some(origin => {
        const match = origin.match(/^(\*|https?):\/\/(\*\.)?([^/]+)\/\*$/);
        return match && (match[1] === '*' || match[1] === scheme)
            && (domain === match[3] || (match[2] && domain.endsWith('.' + match[3])));
    });
}

function createRuntime(options = {}) {
    const listeners = new Set();
    const timers = new Set();
    const fetches = [];
    const registrations = [];
    const cookieQueries = [];
    const logEntries = [];
    let cookieReads = 0;
    const runtime = {
        listeners,
        timers,
        fetches,
        registrations,
        cookieQueries,
        logEntries,
        before: options.before || originalCookies,
        after: options.after || options.before || originalCookies,
        emit(overrides = {}) {
            const details = {
                url: 'https://flow.google.com/projects', method: 'GET',
                initiator: 'chrome-extension://test-extension',
                requestHeaders: [
                    { name: 'Cookie', value: options.wire || 'OSID=session-secret; SID=account-secret' },
                    { name: 'Sec-Session-Google-Response', value: 'proof-secret' },
                    { name: 'Authorization', value: 'Bearer authorization-secret' },
                ],
                ...overrides,
            };
            for (const listener of listeners) listener(details);
        },
    };
    const context = vm.createContext({
        URL, AbortController,
        Logger: { info: async message => { logEntries.push(message); } },
        setTimeout(callback) { timers.add(callback); return callback; },
        clearTimeout(callback) { timers.delete(callback); },
        chrome: {
            runtime: { id: 'test-extension' },
            permissions: { contains: async () => options.permission !== false },
            cookies: {
                getAll: async details => {
                    cookieQueries.push(details);
                    const snapshot = cookieReads++ === 0 ? runtime.before : runtime.after;
                    return options.enforceCookiePermissions
                        ? snapshot.filter(item => hasCookiePermission(item, options.hostPermissions || manifest.host_permissions))
                        : snapshot;
                },
            },
            webRequest: {
                onBeforeSendHeaders: {
                    addListener(listener, filter, extra) {
                        registrations.push({ filter, extra });
                        listeners.add(listener);
                    },
                    removeListener(listener) { listeners.delete(listener); },
                },
            },
        },
        fetch: async (url, init) => {
            fetches.push({ url, init });
            if (options.fetch) return options.fetch(runtime, init);
            runtime.emit(options.details);
            return {
                status: 200,
                headers: new Map([
                    ['Sec-Session-Google-Challenge', 'challenge-secret'],
                    ['Set-Cookie', 'OSID=rotated-secret'],
                ]),
                text: async () => '"oPEP7c":"native-secret@example.com","SNlM0e":"xsrf-secret"',
            };
        },
    });
    vm.runInContext(executable, context);
    runtime.run = () => vm.runInContext('diagnoseNativeFlowSession()', context);
    runtime.collect = () => vm.runInContext('collectRelevantCookies()', context);
    runtime.query = details => context.chrome.cookies.getAll(details);
    return runtime;
}

function assertClean(runtime) {
    assert.equal(runtime.listeners.size, 0);
    assert.equal(runtime.timers.size, 0);
}

test('manifest limits cookie host permissions to Google HTTP and HTTPS', () => {
    assert.ok(manifest.permissions.includes('webRequest'));
    assert.ok(!manifest.permissions.includes('webRequestBlocking'));
    assert.ok(!manifest.permissions.includes('debugger'));
    assert.deepEqual(manifest.host_permissions, [
        'https://google.com/*', 'https://*.google.com/*',
        'http://google.com/*', 'http://*.google.com/*',
    ]);
});

test('exports all 23 cookies when both canonical cookie protocols are permitted', async () => {
    const missingNames = ['APISID', 'HSID', 'SEARCH_SAMESITE', 'SID', 'SIDCC', '_ga', '_ga_X2GNH8R5NS'];
    const nativeNames = [
        '__Secure-BUCKET', 'HSID', 'SSID', 'APISID', 'SAPISID',
        '__Secure-1PAPISID', '__Secure-3PAPISID', '__Secure-ENID', 'SEARCH_SAMESITE',
        '_ga', 'SID', '__Secure-1PSID', '__Secure-3PSID', 'AEC', 'OSID', '__Secure-OSID',
        'NID', '__Secure-1PSIDTS', '__Secure-3PSIDTS', '_ga_X2GNH8R5NS', 'SIDCC',
        '__Secure-1PSIDCC', '__Secure-3PSIDCC',
    ];
    const fullCookies = nativeNames.map(name => ({
        ...cookie(name, name + '-private'),
        secure: !missingNames.includes(name),
        hostOnly: name === 'OSID' || name === '__Secure-OSID',
        domain: name === 'OSID' || name === '__Secure-OSID' ? 'flow.google.com' : '.google.com',
    }));
    const runtime = createRuntime({
        before: fullCookies,
        enforceCookiePermissions: true,
        wire: fullCookies.map(item => `${item.name}=${item.value}`).join('; '),
    });
    const collected = await runtime.collect();
    assert.deepEqual(Array.from(collected, item => item.name), nativeNames);
    assert.equal(collected.find(item => item.name === 'SID').secure, false);
    assert.equal(collected.find(item => item.name === 'OSID').hostOnly, true);
    const result = await runtime.run();
    assert.equal(result.exported_before_count, 23);
    assert.equal(result.attempts[0].before.matches, true);
    assert.equal(result.attempts[0].before.pair_order_matches, true);
    assert.equal(result.attempts[0].after.matches, true);
    assert.ok(runtime.cookieQueries.every(query => query.url === 'https://flow.google.com/projects' && query.domain === undefined));
    assert.doesNotMatch(JSON.stringify(result) + JSON.stringify(runtime.logEntries), /private/);
    assertClean(runtime);
});

test('domain queries cannot bypass missing HTTP cookie permission', async () => {
    const runtime = createRuntime({
        before: [cookie('OSID', 'flow-private'), { ...cookie('SID', 'account-private'), secure: false }],
        enforceCookiePermissions: true,
        hostPermissions: ['https://google.com/*', 'https://*.google.com/*'],
    });
    for (const details of [{ url: 'https://flow.google.com/projects' }, { domain: 'google.com' }]) {
        const cookies = await runtime.query(details);
        assert.deepEqual(Array.from(cookies, item => item.name), ['OSID']);
    }
});

test('compares native wire cookies without exposing values, identities or proofs', async () => {
    const runtime = createRuntime();
    const result = await runtime.run();
    assert.equal(result.browser_account_known, true);
    assert.equal(result.browser_xsrf_present, true);
    assert.equal(result.attempts[0].before.matches, true);
    assert.equal(result.attempts[0].after.matches, true);
    assert.deepEqual(Array.from(result.attempts[0].cookie_names), ['OSID', 'SID']);
    assert.deepEqual(Array.from(result.attempts[0].request_session_header_names), [
        'authorization', 'sec-session-google-response',
    ]);
    assert.equal(result.account_saved, false);
    assert.equal(runtime.fetches.length, 1);
    assert.equal(runtime.fetches[0].url, 'https://flow.google.com/projects');
    assert.equal(runtime.fetches[0].init.credentials, 'include');
    assert.equal(runtime.fetches[0].init.headers, undefined);
    assert.ok(runtime.registrations[0].extra.includes('extraHeaders'));
    assert.deepEqual(Array.from(runtime.registrations[0].filter.urls), ['https://flow.google.com/projects']);
    assert.doesNotMatch(JSON.stringify(result), /secret|Bearer|@example/);
    assertClean(runtime);
});

test('identifies missing and changed cookies while tolerating equals signs in values', async () => {
    const runtime = createRuntime({
        before: [cookie('OSID', 'old'), cookie('EXPORTED_ONLY', 'private')],
        wire: 'OSID=new==; WIRE_ONLY=hidden',
    });
    const result = await runtime.run();
    const comparison = result.attempts[0].before;
    assert.equal(comparison.matches, false);
    assert.deepEqual(Array.from(comparison.missing_from_export), ['WIRE_ONLY']);
    assert.deepEqual(Array.from(comparison.not_sent), ['EXPORTED_ONLY']);
    assert.deepEqual(Array.from(comparison.changed_names), ['OSID']);
    assert.doesNotMatch(JSON.stringify(result), /new==|private|hidden/);
    assertClean(runtime);
});

test('distinguishes rotation and duplicate cookie names without losing pair ordering', async () => {
    const runtime = createRuntime({
        before: [
            { ...cookie('OSID', 'old'), domain: 'flow.google.com', hostOnly: true },
            cookie('OSID', 'second'),
        ],
        after: [
            cookie('OSID', 'second'),
            { ...cookie('OSID', 'new=='), domain: 'flow.google.com', hostOnly: true },
        ],
        wire: 'OSID=new==; OSID=second',
    });
    const result = await runtime.run();
    assert.equal(result.attempts[0].before.matches, false);
    assert.equal(result.attempts[0].after.matches, true);
    assert.equal(result.attempts[0].after.pair_order_matches, false);
    assert.equal(result.attempts[0].cookie_count, 2);
    assertClean(runtime);
});

test('ignores other extensions, tabs, methods and paths', async () => {
    for (const details of [
        { initiator: 'chrome-extension://another-extension' },
        { initiator: 'https://flow.google.com' },
        { url: 'https://flow.google.com/another-path' },
        { method: 'POST' },
    ]) {
        const runtime = createRuntime({ details });
        const result = await runtime.run();
        assert.equal(result.request_observed, false);
        assert.equal(result.attempts.length, 0);
        assertClean(runtime);
    }
});

test('does not equate hidden headers with an empty wire cookie set', async () => {
    const runtime = createRuntime({ details: { requestHeaders: [] } });
    const result = await runtime.run();
    assert.equal(result.request_observed, true);
    assert.equal(result.attempts[0].cookie_header_observed, false);
    assert.equal(result.attempts[0].before, null);
    assert.equal(result.attempts[0].after, null);
    assertClean(runtime);
});

test('missing permission never requests Google', async () => {
    const runtime = createRuntime({ permission: false });
    const result = await runtime.run();
    assert.equal(result.error_code, 'web_request_permission_required');
    assert.equal(runtime.fetches.length, 0);
    assertClean(runtime);
});

test('network failures are redacted and allow a subsequent diagnostic', async () => {
    const runtime = createRuntime({ fetch: async () => { throw new Error('cookie-secret@example.com'); } });
    for (let attempt = 0; attempt < 2; attempt += 1) {
        const result = await runtime.run();
        assert.equal(result.error_code, 'diagnostic_failed');
        assert.doesNotMatch(JSON.stringify(result), /secret|@example/);
        assertClean(runtime);
    }
});

test('concurrent invocation is rejected and timeout releases observer and lock', async () => {
    let markFetchStarted;
    const fetchStarted = new Promise(resolve => { markFetchStarted = resolve; });
    const runtime = createRuntime({
        fetch: async (_runtime, init) => new Promise((resolve, reject) => {
            init.signal.addEventListener('abort', () => reject(Object.assign(new Error('private'), { name: 'AbortError' })));
            markFetchStarted();
        }),
    });
    const pending = runtime.run();
    const concurrent = await runtime.run();
    assert.equal(concurrent.error_code, 'diagnostic_already_running');
    await fetchStarted;
    for (const callback of Array.from(runtime.timers)) callback();
    const result = await pending;
    assert.equal(result.error_code, 'diagnostic_timeout');
    assertClean(runtime);
});