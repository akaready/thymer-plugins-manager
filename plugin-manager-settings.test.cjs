const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

class MemoryStorage {
    constructor({ noOp = false } = {}) { this.values = new Map(); this.noOp = noOp; }
    getItem(key) { return this.values.has(String(key)) ? this.values.get(String(key)) : null; }
    setItem(key, value) { if (!this.noOp) this.values.set(String(key), String(value)); }
    removeItem(key) { this.values.delete(String(key)); }
}

function loadPluginClass(storage = new MemoryStorage(), globals = {}) {
    const filename = path.join(__dirname, 'plugin.js');
    const source = fs.readFileSync(filename, 'utf8') + '\nglobalThis.__PluginManager = Plugin;';
    const context = vm.createContext({
        AppPlugin: class {},
        clearInterval: globals.clearInterval || clearInterval,
        clearTimeout: globals.clearTimeout || clearTimeout,
        console: { log: console.log, error: console.error, warn() {} },
        document: globals.document,
        localStorage: storage,
        setInterval: globals.setInterval || setInterval,
        setTimeout: globals.setTimeout || setTimeout,
    });
    vm.runInContext(source, context, { filename });
    return { PluginManager: context.__PluginManager, storage };
}

function fakeNode() {
    return {
        children: [],
        style: {},
        _text: '',
        appendChild(child) { this.children.push(child); return child; },
        append(...children) { this.children.push(...children); },
        replaceChildren(...children) { this.children = children; },
        get textContent() { return this._text; },
        set textContent(value) { this._text = String(value); },
    };
}

test('disable snapshots live custom settings and verifies the backup before trashing', async () => {
    const { PluginManager, storage } = loadPluginClass();
    const manager = Object.create(PluginManager.prototype);
    manager._disabledPlugins = {};
    let trashed = false;
    const plugin = {
        getGuid: () => 'guid-1',
        getExistingCodeAndConfig: () => ({ json: { name: 'Example', type: 'app', custom: { settings: { value: 7 } } } }),
        trashPlugin: async () => { trashed = true; return true; },
    };

    await manager._disablePluginCore(plugin, { name: 'Stale', custom: { settings: { value: 1 } } });

    assert.equal(trashed, true);
    const backup = JSON.parse(storage.getItem('pm_disabled_plugins'));
    assert.deepEqual(backup['local:guid-1'].custom, { settings: { value: 7 } });
});

test('disable refuses to trash when storage silently drops the settings backup', async () => {
    const { PluginManager } = loadPluginClass(new MemoryStorage({ noOp: true }));
    const manager = Object.create(PluginManager.prototype);
    manager._disabledPlugins = {};
    let trashed = false;
    const plugin = {
        getGuid: () => 'guid-2',
        getExistingCodeAndConfig: () => ({ json: { name: 'Example', type: 'app', custom: { value: 9 } } }),
        trashPlugin: async () => { trashed = true; return true; },
    };

    await assert.rejects(() => manager._disablePluginCore(plugin, plugin.getExistingCodeAndConfig().json), /verify/i);
    assert.equal(trashed, false);
});

test('enable removes the backup only after restored custom settings read back exactly', async () => {
    const { PluginManager, storage } = loadPluginClass();
    const manager = Object.create(PluginManager.prototype);
    const disabled = {
        key: 'local:guid-3',
        guid: 'guid-3',
        name: 'Example',
        type: 'app',
        sourceRepo: null,
        custom: { settings: { second: 2, first: 1 } },
        json: { name: 'Example', type: 'app' },
        code: 'class Plugin extends AppPlugin {}',
        css: '',
    };
    manager._disabledPlugins = { [disabled.key]: disabled };
    manager._saveDisabledPlugins();
    manager.installPlugin = async (json) => ({
        getExistingCodeAndConfig: () => ({ json: { ...json, custom: { settings: { first: 1, second: 2 } } } }),
    });

    assert.equal(await manager._enableDisabledPluginCore(disabled), 'Example');
    assert.deepEqual(JSON.parse(storage.getItem('pm_disabled_plugins')), {});
});

test('enable keeps the backup when restored settings cannot be verified', async () => {
    const { PluginManager, storage } = loadPluginClass();
    const manager = Object.create(PluginManager.prototype);
    const disabled = {
        key: 'local:guid-4',
        guid: 'guid-4',
        name: 'Example',
        type: 'app',
        sourceRepo: null,
        custom: { settings: { value: 4 } },
        json: { name: 'Example', type: 'app' },
        code: '',
        css: '',
    };
    manager._disabledPlugins = { [disabled.key]: disabled };
    manager._saveDisabledPlugins();
    manager.installPlugin = async (json) => ({
        getExistingCodeAndConfig: () => ({ json: { ...json, custom: { settings: { value: 0 } } } }),
    });

    await assert.rejects(() => manager._enableDisabledPluginCore(disabled), /could not be verified/i);
    assert.ok(JSON.parse(storage.getItem('pm_disabled_plugins'))[disabled.key]);
});

test('manager preferences keep a retry journal until config save is confirmed', async () => {
    const { PluginManager, storage } = loadPluginClass();
    const manager = Object.create(PluginManager.prototype);
    let conf = { name: 'Plugins Manager', custom: { community_repos: 'old', saved_themes: [] } };
    let accept = false;
    manager.getGuid = () => 'manager-guid';
    manager.getConfiguration = () => JSON.parse(JSON.stringify(conf));
    manager.data = {
        getPluginByGuid: () => ({
            saveConfiguration: async (next) => {
                if (!accept) return false;
                conf = JSON.parse(JSON.stringify(next));
                return true;
            },
        }),
    };
    manager.ui = { addToaster() {} };
    manager._savedThemes = [];
    manager._autoExportEnabled = false;

    assert.equal(await manager._saveManagerSettings({ communityRepos: 'new', savedThemes: [{ name: 'Dark' }] }), false);
    assert.deepEqual(JSON.parse(storage.getItem('pm_manager_settings_recovery')), {
        community_repos: 'new',
        saved_themes: [{ name: 'Dark' }],
    });

    accept = true;
    assert.equal(await manager._saveManagerSettings(), true);
    assert.equal(conf.custom.community_repos, 'new');
    assert.deepEqual(conf.custom.saved_themes, [{ name: 'Dark' }]);
    assert.equal(storage.getItem('pm_manager_settings_recovery'), null);
});

test('progress tally fills exactly when its matching row becomes opaque', () => {
    const document = {
        createDocumentFragment: fakeNode,
        createElement: fakeNode,
    };
    const { PluginManager } = loadPluginClass(new MemoryStorage(), { document });
    const manager = Object.create(PluginManager.prototype);
    manager._statusNode = fakeNode();
    manager._titleNode = fakeNode();
    manager._status = {
        title: 'Checking',
        total: 2,
        done: 1,
        final: false,
        verb: 'Checking',
        verbDone: 'Checked',
        finalTitle: '',
        items: [
            { name: 'First', state: 'done', version: '1.0.0' },
            { name: 'Second', state: 'pending', version: '1.0.0' },
        ],
    };

    manager._renderStatus();
    let body = manager._statusNode.children[0];
    let bar = body.children[0];
    assert.equal(bar.children[0].textContent, '▰');
    assert.equal(bar.children[1].textContent, '▱');
    assert.equal(body.children[1].style.opacity, undefined);
    assert.equal(body.children[2].style.opacity, '0.55');

    manager._status.items[1].state = 'active';
    manager._renderStatus();
    body = manager._statusNode.children[0];
    bar = body.children[0];
    assert.equal(bar.children[0].textContent, '▰');
    assert.equal(bar.children[1].textContent, '▰');
    assert.equal(body.children[2].style.opacity, undefined);
});

test('a plugin that was actually updated renders its cell and row in Thymer green', () => {
    const document = {
        createDocumentFragment: fakeNode,
        createElement: fakeNode,
    };
    const { PluginManager } = loadPluginClass(new MemoryStorage(), { document });
    const manager = Object.create(PluginManager.prototype);
    manager._statusNode = fakeNode();
    manager._titleNode = fakeNode();
    manager._status = {
        title: 'Updating',
        total: 2,
        done: 2,
        final: false,
        verb: 'Updating',
        verbDone: 'Updated',
        finalTitle: '',
        items: [
            { name: 'Freshly Updated', state: 'done', from: '1.0.0', to: '1.1.0', updated: true },
            { name: 'Already Current', state: 'done', version: '1.0.0' },
        ],
    };

    manager._renderStatus();
    const body = manager._statusNode.children[0];
    const bar = body.children[0];

    // The updated plugin's cell is green; the untouched one is left alone.
    assert.equal(bar.children[0].style.color, 'var(--logo-color, #04d1ab)');
    assert.equal(bar.children[1].style.color, undefined);

    // Same split for the row mark + text.
    const updatedRow = body.children[1];
    const plainRow = body.children[2];
    assert.equal(updatedRow.children[0].style.color, 'var(--logo-color, #04d1ab)');
    assert.equal(updatedRow.children[1].style.color, 'var(--logo-color, #04d1ab)');
    assert.equal(plainRow.children[0].style.color, undefined);
    assert.equal(plainRow.children[1].style.color, undefined);
});

test('seeding the apply phase from a prior check keeps the full list, only resetting rows being updated', () => {
    const { PluginManager } = loadPluginClass();
    const manager = Object.create(PluginManager.prototype);
    // A completed check phase left the toast showing all three candidates.
    manager._status = {
        items: [
            { guid: 'g1', name: 'Alpha', state: 'done', version: '1.0.0' },
            { guid: 'g2', name: 'Beta', state: 'done', version: '2.0.0' },
            { guid: 'g3', name: 'Gamma', state: 'done', version: '3.0.0' },
        ],
    };

    const fakePlugin = (guid, name, version) => ({
        getGuid: () => guid,
        getExistingCodeAndConfig: () => ({ json: { name, version } }),
    });
    // Only Beta has an update available.
    const pluginsToUpdate = [fakePlugin('g2', 'Beta', '2.0.0')];
    const availableUpdates = { g2: { version: '2.1.0' } };

    const items = manager._seedUpdateItems(pluginsToUpdate, availableUpdates);

    assert.equal(items.length, 3);
    assert.equal(items[0].guid, 'g1');
    assert.equal(items[0].state, 'done');
    assert.equal(items[2].guid, 'g3');
    assert.equal(items[2].state, 'done');
    assert.equal(items[1].guid, 'g2');
    assert.equal(items[1].state, 'pending');
    assert.equal(items[1].from, '2.0.0');
    assert.equal(items[1].to, '2.1.0');

    assert.equal(manager._rowIndexByGuid.get('g2'), 1);
});

test('final status auto-dismisses after five idle seconds and keeps the requested title', () => {
    let timeoutMs = null;
    let timeoutCallback = null;
    let destroyed = false;
    const document = {
        createDocumentFragment: fakeNode,
        createElement: fakeNode,
    };
    const { PluginManager } = loadPluginClass(new MemoryStorage(), {
        document,
        setTimeout(callback, ms) { timeoutCallback = callback; timeoutMs = ms; return 17; },
        clearTimeout() {},
    });
    const manager = Object.create(PluginManager.prototype);
    manager._statusNode = fakeNode();
    manager._titleNode = fakeNode();
    manager._progressToast = { destroy() { destroyed = true; } };
    manager._status = {
        title: 'Checking', total: 0, done: 0, items: [], final: true,
        verb: '', verbDone: '', finalTitle: 'Everything up to date!',
    };

    manager._renderStatus();
    assert.equal(manager._titleNode.textContent, 'Everything up to date!');
    manager._scheduleStatusAutoDismiss();
    assert.equal(timeoutMs, 5000);
    timeoutCallback();
    assert.equal(destroyed, true);
    assert.equal(manager._progressToast, null);
});
