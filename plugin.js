// Fallback only — the live value is read from the plugin's own config at load.
const PM_VERSION = '1.23.6';
const PM_UP_TO_DATE_TITLE = 'Everything up to date!';
const PM_STATUS_TOAST_IDLE_MS = 5000;

// Curated per-card color palette (one representative Tailwind-500 per hue). Kept small
// and inlined so this paste-only plugin stays self-contained (no shared-module import).
const PM_CARD_COLORS = [
    { name: 'Slate', hex: '#64748b' },
    { name: 'Red', hex: '#ef4444' },
    { name: 'Orange', hex: '#f97316' },
    { name: 'Amber', hex: '#f59e0b' },
    { name: 'Green', hex: '#22c55e' },
    { name: 'Teal', hex: '#14b8a6' },
    { name: 'Cyan', hex: '#06b6d4' },
    { name: 'Blue', hex: '#3b82f6' },
    { name: 'Indigo', hex: '#6366f1' },
    { name: 'Violet', hex: '#8b5cf6' },
    { name: 'Pink', hex: '#ec4899' }
];

class Plugin extends AppPlugin {

    onLoad() {
        // We load PAT from plugin configuration, removing from cleartext localstorage if found
        const conf = this.getConfiguration();
        this.githubPat = conf?.custom?.githubPat || '';
        // Our own version + repo, for the header badge.
        this._selfVersion = conf?.version || conf?.custom?.pluginVersion || PM_VERSION;
        this._selfRepo = conf?.__source_repo || 'https://github.com/ahpatel/thymer-plugins-manager';
        this._selfIcon = conf?.icon || 'box';
        if (localStorage.getItem('pm_github_pat')) localStorage.removeItem('pm_github_pat');
        if (localStorage.getItem('pm_github_pat_persistent')) localStorage.removeItem('pm_github_pat_persistent');
        this.communityRepos = conf?.custom?.community_repos || localStorage.getItem('pm_community_repos') || 'https://raw.githubusercontent.com/ed-nico/awesome-thymer/main/README.md';
        this._updateIntervalId = null;
        this._activeModals = []; // track all open modals for cleanup on unload
        try { this._disabledPlugins = JSON.parse(localStorage.getItem('pm_disabled_plugins') || '{}'); } catch (e) { this._disabledPlugins = {}; }
        try { this._pluginColors = JSON.parse(localStorage.getItem('pm_plugin_colors') || '{}'); } catch (e) { this._pluginColors = {}; }
        // Cached Discover metadata (version + icon) read from each repo's plugin.json via
        // raw.githubusercontent.com — not the rate-limited GitHub API.
        try { this._discoverMeta = JSON.parse(localStorage.getItem('pm_discover_meta') || '{}'); } catch (e) { this._discoverMeta = {}; }
        // Per-tab list search/sort/filter state (search text is never persisted).
        this._listCache = { app: [], collection: [] };
        this._listState = { app: this._defaultListState(), collection: this._defaultListState() };
        try {
            const saved = JSON.parse(localStorage.getItem('pm_list_state') || '{}');
            for (const tab of ['app', 'collection']) {
                if (saved[tab]) Object.assign(this._listState[tab], saved[tab], { q: '' });
            }
        } catch (e) { }
        try { this._incompatiblePlugins = JSON.parse(localStorage.getItem('pm_incompatible') || '{}'); } catch (e) { this._incompatiblePlugins = {}; }
        // Evict stale incompatible entries older than 30 days
        const _cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
        Object.keys(this._incompatiblePlugins).forEach(k => {
            if (new Date(this._incompatiblePlugins[k].date || 0).getTime() < _cutoff)
                delete this._incompatiblePlugins[k];
        });
        localStorage.setItem('pm_incompatible', JSON.stringify(this._incompatiblePlugins));
        let savedThemes = conf?.custom?.saved_themes;

        if (!savedThemes) {
            const oldThemesRaw = localStorage.getItem('pm_saved_themes');
            if (oldThemesRaw) {
                try {
                    savedThemes = JSON.parse(oldThemesRaw);
                    // Schedule migration to config after load
                    setTimeout(() => {
                        this._savedThemes = savedThemes;
                        this._saveThemes();
                    }, 1000);
                } catch (e) { }
            }
        }

        this._savedThemes = savedThemes || [];
        this._autoExportEnabled = typeof conf?.custom?.auto_export_enabled === 'boolean'
            ? conf.custom.auto_export_enabled
            : localStorage.getItem('pm_auto_export') === 'true';
        this._autoExportDirHandle = null;
        this._autoExportDirName = localStorage.getItem('pm_auto_export_dir_name') || '';
        this._autoExportMode = localStorage.getItem('pm_auto_export_mode') || ''; // 'fsaccess' | 'download' | ''
        this._autoExportCaps = this._detectAutoExportCaps();
        // Restore directory handle from IndexedDB (browser File System Access API)
        this._restoreAutoExportHandle();

        // One-time migration: normalize pm_updates_available entries to {name, version}
        try {
            const rawUpdates = JSON.parse(localStorage.getItem('pm_updates_available') || '{}');
            let migrated = false;
            for (const k of Object.keys(rawUpdates)) {
                const v = rawUpdates[k];
                if (!v || typeof v !== 'object' || typeof v.version !== 'string') {
                    rawUpdates[k] = { name: '', version: typeof v === 'string' ? v : (v?.version || '') };
                    migrated = true;
                }
            }
            if (migrated) localStorage.setItem('pm_updates_available', JSON.stringify(rawUpdates));
        } catch (e) { /* ignore */ }

        // Register the panel type
        this.ui.registerCustomPanelType("plugin-manager-panel", (panel) => {
            this.renderUI(panel);
        });

        // Add a status bar button to launch it
        this._statusBarItem = this.ui.addStatusBarItem({
            icon: "box",
            tooltip: "Plugins Manager",
            onClick: async () => {
                const newPanel = await this.ui.createPanel();
                if (newPanel) {
                    newPanel.navigateToCustomType("plugin-manager-panel");
                }
            }
        });

        /*
         * Runs fire-and-forget: the palette closes immediately, the work continues in the
         * background, and it never opens the Plugins Manager panel — the point is to update
         * without leaving what you're doing.
         *
         * All progress goes through ONE replaceable status toast (`_toastProgress`), because
         * Thymer overlays toasters instead of queueing them — a toast per step just buries the
         * previous one. `announce`/`notifyNew: false` silence the check's own toasts for the
         * same reason; this command reports its own outcome.
         */
        this.ui.addCommandPaletteCommand({
            label: "Update all Installed Plugins",
            icon: "box",
            onSelected: () => {
                void (async () => {
                    try {
                        this._toastProgress('Checking for updates…');
                        await this.checkForAllUpdatesInBackground({ manual: true, notifyNew: false, announce: false });
                        // No confirm dialog: choosing this command IS the confirmation, and a
                        // modal would defeat the point of it running unattended.
                        await this._applyAvailableUpdates({
                            scope: 'all',
                            announceNoop: true,
                            confirm: false,
                            notify: true,
                        });
                    } catch (e) {
                        console.error(e);
                        this._toastSummary('Update All Failed', e.message);
                    }
                })();
            }
        });

        // Add a command palette command to launch it
        this.ui.addCommandPaletteCommand({
            label: "Open Plugins Manager",
            icon: "box",
            onSelected: async () => {
                const newPanel = await this.ui.createPanel();
                if (newPanel) {
                    newPanel.navigateToCustomType("plugin-manager-panel");
                }
            }
        });

        // Check if we just updated ourselves
        if (localStorage.getItem('pm_self_update_pending') === 'true') {
            localStorage.removeItem('pm_self_update_pending');
            setTimeout(async () => {
                try {
                    const newPanel = await this.ui.createPanel();
                    if (newPanel) {
                        newPanel.navigateToCustomType("plugin-manager-panel");
                    }
                } catch (e) { console.error('Failed to reopen panel after self-update', e); }
            }, 800);
        }

        // Reflect any already-cached updates in the status bar tooltip
        this._updateStatusBarIcon();

        // Start automated update checker
        this.startAutomatedUpdateChecker();

        // Close dropdown menu if user clicks outside
        this._globalMenuCloseHandler = (e) => {
            if (!e.target.closest('.pm-card-overflow-trigger') && !e.target.closest('.pm-card-actions-wrapper')) {
                document.querySelectorAll('.pm-card-actions-wrapper.pm-open').forEach(el => {
                    el.classList.remove('pm-open');
                });
            }
        };
        document.addEventListener('click', this._globalMenuCloseHandler);
    }

    onUnload() {
        // Clean up interval to prevent memory leaks
        if (this._updateIntervalId) {
            clearInterval(this._updateIntervalId);
            this._updateIntervalId = null;
        }
        this._discoverItems = null;
        this._clearProgressToast(); // don't leave a status toast stranded on screen
        this._closeColorPopover();
        if (this._pointerHandler) {
            document.removeEventListener('mousedown', this._pointerHandler, true);
            this._pointerHandler = null;
        }
        for (const t of Object.values(this._searchTimers || {})) clearTimeout(t);
        this._searchTimers = {};
        for (const layer of (this._confettiLayers || [])) {
            if (layer && layer.parentNode) layer.parentNode.removeChild(layer);
        }
        this._confettiLayers = [];
        // Remove any dangling modals from the DOM to prevent memory leaks
        for (const modal of (this._activeModals || [])) {
            if (modal && modal.parentNode) modal.parentNode.removeChild(modal);
        }
        this._activeModals = [];
        // Disconnect responsive resize observer
        if (this._resizeObserver) {
            this._resizeObserver.disconnect();
            this._resizeObserver = null;
        }
        // Clean up instant-tooltip listeners + DOM
        if (this._tooltipCleanup) {
            try { this._tooltipCleanup(); } catch (e) { }
            this._tooltipCleanup = null;
        }
        if (this._globalMenuCloseHandler) {
            document.removeEventListener('click', this._globalMenuCloseHandler);
            this._globalMenuCloseHandler = null;
        }
    }

    async startAutomatedUpdateChecker() {
        // Run daily
        const lastCheck = localStorage.getItem('pm_last_update_check');
        const now = Date.now();
        if (!lastCheck || now - parseInt(lastCheck) > 24 * 60 * 60 * 1000) {
            await this.checkForAllUpdatesInBackground();
            localStorage.setItem('pm_last_update_check', now.toString());
        }

        // Setup interval to check every 12 hours while open
        this._updateIntervalId = setInterval(() => this.checkForAllUpdatesInBackground(), 12 * 60 * 60 * 1000);
    }

    async checkForAllUpdatesInBackground(options = {}) {
        const isManual = options.manual === true;
        // `announce: false` — the caller is already showing its own status toast, and Thymer
        // overlays toasters rather than queueing them, so a second one here would stack on top
        // of it. Error toasts below are unaffected: those must always surface.
        if (isManual && options.announce !== false) {
            this.ui.addToaster({ title: "Checking for updates...", message: "This may take a moment depending on the number of plugins.", autoDestroyTime: 3000, dismissible: true });
        }

        try {
            const updatesAvailable = {};
            const allGlobals = await this.data.getAllGlobalPlugins();
            const allCollections = await this.data.getAllCollections();
            const allPlugins = [...allGlobals, ...allCollections];
            const MAX_CHECKS = isManual ? 100 : 50; // Higher cap for manual checks

            // Enumerate the checkable plugins UP FRONT so the live toast (when one is up) can
            // show the WHOLE list at once — the • then travels down the list as the loop walks
            // it, and each tally cell fills as its matching row becomes active.
            const candidates = [];
            for (const p of allPlugins) {
                if (candidates.length >= MAX_CHECKS) break;
                try {
                    const { json } = p.getExistingCodeAndConfig();
                    const repo = json.__source_repo;
                    if (repo && this._isValidGithubUrl(repo)) candidates.push({ p, json, repo });
                } catch (e) { }
            }
            if (this._progressToast && candidates.length) {
                this._setStatus({
                    verb: 'Checking', verbDone: 'Checked',
                    total: candidates.length,
                    done: 0,
                    finalTitle: '',
                    items: candidates.map(c => ({
                        name: c.json.name || 'Unnamed Plugin',
                        version: c.json.version || c.json.ver || '?',
                        state: 'pending',
                    })),
                });
            }

            for (let i = 0; i < candidates.length; i++) {
                const { p, json, repo } = candidates[i];
                // The traveling dot: this row goes • while its check runs, settles to ✓/✗ below.
                this._markStatusItem(i, 'active');
                try {
                    const { json: remoteJson } = await this.fetchGithubRepo(repo, { sourceFiles: json.__source_files });
                    if (remoteJson.version && remoteJson.version !== json.version) {
                        updatesAvailable[p.getGuid()] = {
                            name: json.name || "Unnamed Plugin",
                            version: remoteJson.version
                        };
                        // Update found: the row shows "v<current> → v<new>".
                        this._markStatusItem(i, 'done', { from: json.version || '?', to: remoteJson.version });
                    } else {
                        // Up to date: just the current version.
                        this._markStatusItem(i, 'done');
                    }
                    // Avoid GitHub rate limiting between requests
                    await new Promise(r => setTimeout(r, isManual ? 500 : 1000));
                } catch (e) {
                    this._markStatusItem(i, 'failed');
                    if (e.message && (e.message.includes('rate limit') || e.message.includes('403'))) {
                        console.warn('[Plugins Manager] GitHub rate limit hit during check, stopping early.');
                        if (isManual) {
                            this.ui.addToaster({ title: "Rate Limit Hit", message: "GitHub API rate limit reached. Please try again later or add a PAT in Settings.", autoDestroyTime: 5000, dismissible: true });
                        }
                        localStorage.setItem('pm_last_update_check', (Date.now() + 6 * 60 * 60 * 1000).toString());
                        break;
                    }
                }
            }

            localStorage.setItem('pm_updates_available', JSON.stringify(updatesAvailable));
            localStorage.setItem('pm_last_update_check_success', Date.now().toString());
            this._updateStatusBarIcon();

            // Notify user if new updates were found
            const updateCount = Object.keys(updatesAvailable).length;
            if (updateCount > 0) {
                const previousUpdatesStr = localStorage.getItem('pm_last_notified_updates') || '{}';
                let previousUpdates = {};
                try { previousUpdates = JSON.parse(previousUpdatesStr); } catch (e) { }

                // Only notify if there are updates whose version differs from last notification
                let hasNewUpdates = false;
                for (const [guid, info] of Object.entries(updatesAvailable)) {
                    const prev = previousUpdates[guid];
                    const prevVersion = (prev && typeof prev === 'object') ? prev.version : prev;
                    if (prevVersion !== info.version) {
                        hasNewUpdates = true;
                        break;
                    }
                }

                // `notifyNew: false` suppresses this passive nudge for callers that report the
                // outcome themselves — otherwise an explicit "check for updates" command would
                // toast twice.
                if (hasNewUpdates && options.notifyNew !== false) {
                    this.ui.addToaster({
                        title: "Plugin Updates Available",
                        message: `${updateCount} plugin${updateCount === 1 ? '' : 's'} can be updated. Open Plugins Manager to apply.`,
                        autoDestroyTime: 8000,
                        dismissible: true
                    });
                    localStorage.setItem('pm_last_notified_updates', JSON.stringify(updatesAvailable));
                }
            }
        } catch (e) {
            console.error("Update check failed", e);
            if (isManual) {
                this.ui.addToaster({ title: "Update Check Failed", message: e.message, autoDestroyTime: 5000, dismissible: true });
            }
        }
    }

    _updateStatusBarIcon() {
        if (!this._statusBarItem) return;
        const updates = this._readUpdateCache();
        const count = Object.keys(updates).length;
        if (count > 0) {
            const pluginNames = Object.values(updates).map(u => u.name || '').filter(Boolean).join(', ');
            // Some environments truncate native tooltips; keep it to two lines maximum
            this._statusBarItem.setTooltip(`Plugins Manager: ${count} update${count > 1 ? 's' : ''} available${pluginNames ? '\n' + pluginNames : ''}`);
        } else {
            this._statusBarItem.setTooltip("Plugins Manager");
        }
    }

    /** Normalize pm_updates_available to {name, version} shape. */
    _readUpdateCache() {
        let raw;
        try { raw = JSON.parse(localStorage.getItem('pm_updates_available') || '{}'); }
        catch (e) { return {}; }
        const out = {};
        for (const [k, v] of Object.entries(raw || {})) {
            if (v && typeof v === 'object' && typeof v.version === 'string') {
                out[k] = { name: v.name || '', version: v.version };
            } else if (typeof v === 'string' && v) {
                out[k] = { name: '', version: v };
            }
        }
        return out;
    }

    _writeUpdateCache(cache) {
        try { localStorage.setItem('pm_updates_available', JSON.stringify(cache)); } catch (e) { }
    }

    renderUI(panel) {
        const html = `
            <div class="pm-container">
                <div class="pm-header">
                    <span class="pm-header-logo">
                        <span class="pm-header-icon" id="pm-header-icon" aria-hidden="true"></span>
                    </span>
                    <div class="pm-header-titlerow">
                        <h1>Plugins Manager</h1>
                        <span class="pm-header-meta" data-external-url="${this._escHtml(this._selfRepo)}" title="View this plugin on GitHub" role="link" tabindex="0">
                            <span class="pm-header-version">v${this._escHtml(this._selfVersion)}</span>
                            <span class="pm-gh-glyph pm-gh-mark" aria-hidden="true"></span>
                        </span>
                        <span id="pm-header-self-update-btn" class="pm-badge pm-version-badge update pm-hidden" role="button" tabindex="0" style="cursor: pointer;"></span>
                    </div>
                </div>
                
                <div class="pm-tabs">
                    <div class="pm-tab active" data-tab="global" title="Plugins"><span class="pm-tab-icon" data-icon="puzzle"></span><span class="pm-tab-label">Plugins</span></div>
                    <div class="pm-tab" data-tab="collections" title="Collections"><span class="pm-tab-icon" data-icon="folder"></span><span class="pm-tab-label">Collections</span></div>
                    <div class="pm-tab" data-tab="themes" title="Themes"><span class="pm-tab-icon" data-icon="brush"></span><span class="pm-tab-label">Themes</span></div>
                    <div class="pm-tab" data-tab="discover" title="Discover"><span class="pm-tab-icon" data-icon="compass"></span><span class="pm-tab-label">Discover</span></div>
                    <div class="pm-tab" data-tab="settings" title="Settings"><span class="pm-tab-icon" data-icon="settings"></span><span class="pm-tab-label">Settings</span></div>
                </div>

                <div class="pm-tab-content active" id="tab-global">
                    <div class="pm-tab-toolbar">
                        <div class="pm-tab-actions pm-tab-actions-primary">
                            <button class="pm-btn primary" id="pm-install-global-btn">Install Plugin</button>
                            <button class="pm-btn pm-drawer-toggle" id="pm-drawer-toggle-global">More ▾</button>
                        </div>
                    </div>
                    <div class="pm-drawer pm-hidden" id="pm-drawer-global">
                        <div class="pm-drawer-content">
                            <button class="pm-btn" id="pm-import-global-btn">Restore Plugins</button>
                            <button class="pm-btn" id="pm-export-global-btn">Backup Plugins</button>
                            <button class="pm-btn pm-btn-update" id="pm-check-updates-global-btn" title="Check for plugin updates"><span class="pm-btn-icon" aria-hidden="true">↻</span> Check Updates</button>
                            <button class="pm-btn pm-btn-update update-btn pm-hidden" id="pm-update-all-global-btn">Update All</button>
                            <button class="pm-btn pm-btn-alloff" id="pm-disable-all-global-btn" title="Turn off all plugins">All Off</button>
                            <button class="pm-btn pm-btn-allon" id="pm-enable-all-global-btn" title="Turn all disabled plugins back on">All On</button>
                        </div>
                    </div>
                    <div class="pm-list-controls">
                        <input type="text" id="pm-search-global" class="pm-input pm-search-input" placeholder="Search plugins…" autocomplete="off" />
                        <select id="pm-sort-global" class="pm-input pm-select" aria-label="Sort plugins">
                            <option value="name">Name (A–Z)</option>
                            <option value="author">Author (A–Z)</option>
                            <option value="color">Color</option>
                            <option value="status">Active first</option>
                        </select>
                        <div class="pm-chips" id="pm-status-global" role="group" aria-label="Filter by status">
                            <button type="button" class="pm-chip active" data-status="all">All</button>
                            <button type="button" class="pm-chip" data-status="active">Active</button>
                            <button type="button" class="pm-chip" data-status="inactive">Inactive</button>
                        </div>
                        <div class="pm-color-filter pm-hidden" id="pm-colorfilter-global"></div>
                        <div class="pm-seg-group" id="pm-view-global" role="group" aria-label="View mode">
                            <button type="button" class="pm-seg active" data-view="grid" title="Grid view" aria-label="Grid view"></button>
                            <button type="button" class="pm-seg" data-view="list" title="List view" aria-label="List view"></button>
                        </div>
                    </div>
                    <div id="pm-global-list" class="pm-list-container">Loading...</div>
                </div>

                <div class="pm-tab-content" id="tab-collections">
                    <div class="pm-tab-toolbar">
                        <div class="pm-tab-actions pm-tab-actions-primary">
                            <button class="pm-btn primary" id="pm-install-col-btn">Install Collection Plugin</button>
                            <button class="pm-btn pm-drawer-toggle" id="pm-drawer-toggle-col">More ▾</button>
                        </div>
                    </div>
                    <div class="pm-drawer pm-hidden" id="pm-drawer-col">
                        <div class="pm-drawer-content">
                            <button class="pm-btn" id="pm-import-col-btn">Restore Collections</button>
                            <button class="pm-btn" id="pm-export-col-btn">Backup Collections</button>
                            <button class="pm-btn pm-btn-update" id="pm-check-updates-col-btn" title="Check for collection updates"><span class="pm-btn-icon" aria-hidden="true">↻</span> Check Updates</button>
                            <button class="pm-btn pm-btn-update update-btn pm-hidden" id="pm-update-all-col-btn">Update All</button>
                            <button class="pm-btn pm-btn-alloff" id="pm-disable-all-col-btn" title="Turn off all collection plugins">All Off</button>
                            <button class="pm-btn pm-btn-allon" id="pm-enable-all-col-btn" title="Turn all disabled collection plugins back on">All On</button>
                        </div>
                    </div>
                    <div class="pm-list-controls">
                        <input type="text" id="pm-search-col" class="pm-input pm-search-input" placeholder="Search collection plugins…" autocomplete="off" />
                        <select id="pm-sort-col" class="pm-input pm-select" aria-label="Sort collection plugins">
                            <option value="name">Name (A–Z)</option>
                            <option value="author">Author (A–Z)</option>
                            <option value="color">Color</option>
                            <option value="status">Active first</option>
                        </select>
                        <div class="pm-chips" id="pm-status-col" role="group" aria-label="Filter by status">
                            <button type="button" class="pm-chip active" data-status="all">All</button>
                            <button type="button" class="pm-chip" data-status="active">Active</button>
                            <button type="button" class="pm-chip" data-status="inactive">Inactive</button>
                        </div>
                        <div class="pm-color-filter pm-hidden" id="pm-colorfilter-col"></div>
                        <div class="pm-seg-group" id="pm-view-col" role="group" aria-label="View mode">
                            <button type="button" class="pm-seg active" data-view="grid" title="Grid view" aria-label="Grid view"></button>
                            <button type="button" class="pm-seg" data-view="list" title="List view" aria-label="List view"></button>
                        </div>
                    </div>
                    <div id="pm-collections-list" class="pm-list-container">Loading...</div>
                </div>

                
                
                <div class="pm-tab-content" id="tab-discover">
                    <div class="pm-tab-toolbar">
                        <div class="pm-tab-actions pm-tab-actions-primary">
                            <input type="text" id="pm-discover-search" class="pm-input pm-search-input" placeholder="Search plugins, collections, themes..." autocomplete="off" />
                            <select id="pm-discover-sort" class="pm-input pm-select" aria-label="Sort discover results">
                                <option value="name">Name (A–Z)</option>
                                <option value="author">Author (A–Z)</option>
                                <option value="type">Type</option>
                            </select>
                            <div class="pm-filter-chips">
                                <button class="pm-filter-chip active" data-filter="all">All</button>
                                <button class="pm-filter-chip" data-filter="app">Plugins</button>
                                <button class="pm-filter-chip" data-filter="collection">Collections</button>
                                <button class="pm-filter-chip" data-filter="theme">Themes</button>
                            </div>
                        </div>
                        <div class="pm-tab-actions pm-tab-actions-secondary">
                            <button class="pm-btn pm-btn-refresh" id="pm-refresh-discover-btn"><span class="pm-btn-icon" aria-hidden="true">↻</span> Refresh</button>
                        </div>
                    </div>
                    <div id="pm-discover-list" class="pm-list-container">Loading...</div>
                </div>

                
                <div class="pm-tab-content" id="tab-themes">
                    <div class="pm-tab-toolbar">
                        <div class="pm-tab-actions pm-tab-actions-primary">
                            <button class="pm-btn primary" id="pm-add-theme-github-btn">Add from GitHub</button>
                            <button class="pm-btn" id="pm-add-theme-manual-btn">Paste CSS</button>
                        </div>
                        <div class="pm-tab-actions pm-tab-actions-secondary">
                            <button class="pm-btn" id="pm-export-all-themes-btn">Backup Theme CSS</button>
                        </div>
                    </div>
                    <div id="pm-themes-list" class="pm-list-container"></div>
                </div>

                <div class="pm-tab-content" id="tab-settings">
                    <div class="pm-card pm-settings-card">
                        <form class="pm-settings-form" onsubmit="return false;">
                            <div class="pm-settings-section">
                                <h3>GitHub Access</h3>
                                <div class="pm-input-group">
                                <label>GitHub Personal Access Token (Optional)</label>
                                <p class="pm-settings-help">
                                    Provide a PAT to increase API rate limits when updating or restoring many plugins. It is stored only in this plugin's configuration.
                                </p>
                                <input type="password" id="pm-pat-input" class="pm-input" placeholder="ghp_xxxxxxxxxxxx" value="${this._escHtml(this.githubPat)}" autocomplete="off">
                            </div>
                            </div>
                            
                            <div class="pm-settings-section">
                                <h3>Community Sources</h3>
                                <div class="pm-input-group pm-input-group-flush">
                                <label>Community Repositories</label>
                                <p class="pm-settings-help">
                                    List of raw Markdown URLs (one per line) to discover community plugins and themes.
                                </p>
                                <textarea id="pm-repos-input" class="pm-textarea pm-textarea-urls" placeholder="https://raw.githubusercontent.com/.../README.md">${this._escHtml(this.communityRepos)}</textarea>
                            </div>
                            </div>

                            <div class="pm-settings-section">
                                <h3>Workspace Backup &amp; Restore</h3>
                                <p class="pm-settings-help">
                                    Create a single backup for plugins, collections, theme library, and Plugins Manager settings, or restore that backup into a new workspace.
                                </p>
                                <div class="pm-tab-actions pm-settings-actions">
                                    <button type="button" class="pm-btn primary" id="pm-export-workspace-btn">Backup Workspace</button>
                                    <button type="button" class="pm-btn" id="pm-import-workspace-btn">Restore Workspace</button>
                                    <button type="button" class="pm-btn" id="pm-export-workspace-themes-btn">Backup Theme CSS</button>
                                </div>
                                <div id="pm-workspace-summary" class="pm-settings-summary"></div>
                            </div>

                            <div class="pm-settings-section">
                                <h3>Automatic Backups</h3>
                                <label class="pm-checkbox-row">
                                    <input type="checkbox" id="pm-auto-export-toggle" ${this._autoExportEnabled ? 'checked' : ''} />
                                    Auto-Backup Workspace on Changes
                                </label>
                                <p class="pm-settings-help pm-settings-help-tight">
                                    Automatically save a full workspace backup whenever plugins, collections, or themes change.
                                </p>
                                <div class="pm-inline-row">
                                    <button type="button" class="pm-btn" id="pm-auto-export-dir-btn">${this._autoExportCaps.hasFSAccess ? 'Choose Directory' : 'Choose Destination'}</button>
                                    <span id="pm-auto-export-dir-label" class="pm-settings-help pm-settings-help-flush">${this._escHtml(this._autoExportDestinationLabel())}</span>
                                </div>
                                <p class="pm-settings-help pm-settings-hint" id="pm-auto-export-mode-help">${this._escHtml(this._autoExportModeHint())}</p>
                            </div>

                            <div class="pm-settings-footer">
                                <button type="button" class="pm-btn primary" id="pm-save-settings">Save Settings</button>
                            </div>
                        </form>
                    </div>
                </div>
            </div>
        `;

        const element = panel.getElement();
        if (element) {
            element.innerHTML = html;
            this._populateTabIcons(element);
            this._installInstantTooltips(element);
            this.bindEvents(element, panel);
            this.loadPlugins(element);
            // Discover tab is loaded lazily on first click (see bindEvents)
        }
    }

    /**
     * Show button tooltips instantly (no browser title delay) for any element
     * inside the plugin panel that has a [title] attribute. The native title
     * is moved to data-pm-tip during hover so the browser's slow default
     * tooltip doesn't double up.
     */
    _installInstantTooltips(root) {
        if (!root) return;
        const tip = document.createElement('div');
        tip.className = 'pm-tooltip';
        tip.setAttribute('role', 'tooltip');
        tip.style.display = 'none';
        document.body.appendChild(tip);
        this._tooltipEl = tip;

        let activeTarget = null;

        const hide = () => {
            tip.style.display = 'none';
            if (activeTarget && activeTarget.dataset && activeTarget.dataset.pmTip != null) {
                // restore native title on leave so it remains accessible to
                // accessibility tools / non-mouse interactions
                activeTarget.setAttribute('title', activeTarget.dataset.pmTip);
                delete activeTarget.dataset.pmTip;
            }
            activeTarget = null;
        };

        const show = (target, ev) => {
            const text = target.getAttribute('title') || target.dataset.pmTip;
            if (!text) return;
            // suppress browser's native delayed tooltip while we show our own
            if (target.hasAttribute('title')) {
                target.dataset.pmTip = target.getAttribute('title');
                target.removeAttribute('title');
            }
            activeTarget = target;
            tip.textContent = text;
            tip.style.display = 'block';
            this._positionTooltip(tip, target, ev);
        };

        const onOver = (e) => {
            const target = e.target.closest('[title], [data-pm-tip]');
            if (!target || !root.contains(target)) return;
            if (target === activeTarget) return;
            if (activeTarget) hide();
            show(target, e);
        };

        const onOut = (e) => {
            if (!activeTarget) return;
            const next = e.relatedTarget;
            if (next && activeTarget.contains(next)) return;
            hide();
        };

        const onMove = (e) => {
            if (activeTarget) this._positionTooltip(tip, activeTarget, e);
        };

        const onScrollOrBlur = () => hide();

        root.addEventListener('mouseover', onOver);
        root.addEventListener('mouseout', onOut);
        root.addEventListener('mousemove', onMove);
        window.addEventListener('scroll', onScrollOrBlur, true);
        window.addEventListener('blur', onScrollOrBlur);

        this._tooltipCleanup = () => {
            root.removeEventListener('mouseover', onOver);
            root.removeEventListener('mouseout', onOut);
            root.removeEventListener('mousemove', onMove);
            window.removeEventListener('scroll', onScrollOrBlur, true);
            window.removeEventListener('blur', onScrollOrBlur);
            if (tip.parentNode) tip.parentNode.removeChild(tip);
            this._tooltipEl = null;
        };
    }

    /** Position the tooltip just below the target, flipped above if needed. */
    _positionTooltip(tip, target) {
        const rect = target.getBoundingClientRect();
        // Make sure we measure final size
        tip.style.left = '0px';
        tip.style.top = '0px';
        const tipRect = tip.getBoundingClientRect();
        const margin = 6;
        let left = rect.left + (rect.width / 2) - (tipRect.width / 2);
        let top = rect.bottom + margin;
        // Flip above if no room below
        if (top + tipRect.height > window.innerHeight - 4) {
            top = rect.top - tipRect.height - margin;
        }
        // Clamp horizontally inside viewport
        left = Math.max(4, Math.min(left, window.innerWidth - tipRect.width - 4));
        tip.style.left = `${Math.round(left)}px`;
        tip.style.top = `${Math.round(top)}px`;
    }

    /**
     * Replace [data-icon] placeholder spans with Thymer's native icons (Tabler).
     * Falls back silently if the icon name is unsupported by the host build.
     */
    _populateTabIcons(root) {
        const slots = root.querySelectorAll('.pm-tab-icon[data-icon]');
        slots.forEach(slot => {
            const name = slot.getAttribute('data-icon');
            if (!name) return;
            try {
                const icon = this.ui.createIcon(name);
                if (icon) {
                    slot.innerHTML = '';
                    slot.appendChild(icon);
                }
            } catch (e) { /* ignore unsupported icon names */ }
        });
    }

    bindEvents(container, panel) {
        // Remember where the user last clicked so confirmations can pop up right there
        // instead of in the middle of the screen.
        this._pointerHandler = (e) => { this._lastPointer = { x: e.clientX, y: e.clientY }; };
        document.addEventListener('mousedown', this._pointerHandler, true);

        // This plugin's own icon, beside the title.
        const headerIcon = container.querySelector('#pm-header-icon');
        if (headerIcon) {
            try { headerIcon.appendChild(this.ui.createIcon(this._selfIcon || 'box')); } catch (e) { }
        }

        // Tabs
        container.querySelector('.pm-tabs').addEventListener('click', (e) => {
            const tabBtn = e.target.closest('.pm-tab');
            if (!tabBtn) return;
            // Remove active classes
            container.querySelectorAll('.pm-tab').forEach(el => el.classList.remove('active'));
            container.querySelectorAll('.pm-tab-content').forEach(el => el.classList.remove('active'));

            // Add active class
            tabBtn.classList.add('active');
            const tabId = tabBtn.getAttribute('data-tab');
            container.querySelector(`#tab-${tabId}`).classList.add('active');

            // Lazy-load Discover tab on first click
            if (tabId === 'discover' && !this._discoverItems) {
                this.loadDiscoverPlugins(container);
            }

            if (tabId === 'global' || tabId === 'collections') this.loadPlugins(container);
            else if (tabId === 'themes') this._renderThemesList(container);
            else if (tabId === 'settings') this._renderWorkspaceSummary(container);
        });

        // Responsive: toggle 'narrow' (icon tabs) and 'wide' (multi-col cards) based on container width
        const pmContainer = container.querySelector('.pm-container');

        // Pin the panel's width so it can't change with content length. Filtering the list
        // (e.g. to "Inactive") makes it short enough to lose its scrollbar, which hands ~15px
        // of width back and visibly resizes the whole interface. .pm-container isn't the
        // scroll host, so find the real one and permanently reserve its scrollbar gutter.
        try {
            const candidates = [];
            let node = pmContainer && pmContainer.parentElement;
            while (node) {
                candidates.push(node);           // walk the FULL chain, incl. <body> and <html>
                node = node.parentElement;
            }
            for (const n of candidates) {
                const oy = getComputedStyle(n).overflowY;
                const scrollable = (oy === 'auto' || oy === 'scroll') || n.scrollHeight > n.clientHeight;
                if (!scrollable) continue;
                n.style.scrollbarGutter = 'stable';
                // Force the gutter even where scrollbar-gutter is unsupported/ignored.
                if (oy !== 'scroll') n.style.overflowY = 'scroll';
            }
        } catch (e) { }

        if (pmContainer && window.ResizeObserver) {
            this._resizeObserver = new ResizeObserver(entries => {
                for (const entry of entries) {
                    const w = entry.contentRect.width;
                    // Hysteresis. Filtering the list (or switching tabs) changes its height,
                    // which makes the panel's scrollbar appear/disappear and shifts our width
                    // by ~15px. Without a deadband that flips these breakpoints and the card
                    // grid jumps between 1 column and multi-column. Each threshold therefore
                    // needs to be overshot by 15px before it flips back.
                    const dead = 15;
                    const hold = (cls, on, off) => {
                        const active = pmContainer.classList.contains(cls);
                        pmContainer.classList.toggle(cls, active ? on : off);
                    };
                    hold('narrow', w < 520 + dead, w < 520 - dead);
                    hold('compact', w < 760 + dead, w < 760 - dead);
                    hold('wide', w > 700 - dead, w > 700 + dead);
                }
            });
            this._resizeObserver.observe(pmContainer);
        }

        // Settings
        container.querySelector('#pm-save-settings').addEventListener('click', async () => {
            const pat = container.querySelector('#pm-pat-input').value.trim();
            const repos = container.querySelector('#pm-repos-input').value.trim();
            const autoExport = container.querySelector('#pm-auto-export-toggle').checked;
            await this._saveManagerSettings({ githubPat: pat, communityRepos: repos, autoExportEnabled: autoExport });
            this._renderWorkspaceSummary(container);

            this.ui.addToaster({ title: "Settings Saved", dismissible: true, autoDestroyTime: 3000 });
        });

        // Auto-export directory / destination picker (adapts to environment)
        container.querySelector('#pm-auto-export-dir-btn').addEventListener('click', async () => {
            await this._chooseAutoExportTarget(container);
        });


        container.querySelector('#pm-refresh-discover-btn').addEventListener('click', () => {
            this.loadDiscoverPlugins(container);
        });

        // Discover search
        container.querySelector('#pm-discover-search').addEventListener('input', () => {
            this._filterDiscoverList(container);
        });

        container.querySelector('#pm-discover-sort').addEventListener('change', () => {
            this._filterDiscoverList(container);
        });

        // Give the Discover filter chips the same glyphs used as the cards' corner type marks.
        const chipGlyphs = { app: 'puzzle', collection: 'folder', theme: 'brush' };
        container.querySelectorAll('#tab-discover .pm-filter-chip').forEach(chip => {
            const glyph = chipGlyphs[chip.dataset.filter];
            if (!glyph) return;
            const span = document.createElement('span');
            span.className = 'pm-chip-icon';
            span.setAttribute('aria-hidden', 'true');
            try { span.appendChild(this.ui.createIcon(glyph)); } catch (e) { return; }
            chip.insertBefore(span, chip.firstChild);
        });

        // Discover filter chips
        container.querySelectorAll('.pm-filter-chip').forEach(chip => {
            chip.addEventListener('click', (e) => {
                container.querySelectorAll('.pm-filter-chip').forEach(c => c.classList.remove('active'));
                e.target.classList.add('active');
                this._filterDiscoverList(container);
            });
        });


        container.querySelector('#pm-add-theme-github-btn').addEventListener('click', () => this._addThemeFromGithub(container));
        container.querySelector('#pm-add-theme-manual-btn').addEventListener('click', () => this._addThemeManually(container));
        container.querySelector('#pm-export-all-themes-btn').addEventListener('click', () => this._exportAllThemes());
        this._renderThemesList(container);
        this._renderWorkspaceSummary(container);

        // Actions
        container.querySelector('#pm-install-global-btn').addEventListener('click', () => this.showInstallDialog(container, 'app'));
        container.querySelector('#pm-import-global-btn').addEventListener('click', () => this.showImportDialog(container, 'app'));
        container.querySelector('#pm-export-global-btn').addEventListener('click', () => this.showExportDialog('app'));
        container.querySelector('#pm-check-updates-global-btn').addEventListener('click', () => this._manualCheckForUpdates(container, 'app'));
        container.querySelector('#pm-update-all-global-btn').addEventListener('click', () => this._updateAllAvailable(container, 'app'));
        container.querySelector('#pm-disable-all-global-btn').addEventListener('click', (e) => this._disableAllPlugins(container, 'app', { el: e.currentTarget, isSwitch: false }));
        container.querySelector('#pm-enable-all-global-btn').addEventListener('click', (e) => this._enableAllPlugins(container, 'app', { el: e.currentTarget, isSwitch: false }));

        container.querySelector('#pm-install-col-btn').addEventListener('click', () => this.showInstallDialog(container, 'collection'));
        container.querySelector('#pm-import-col-btn').addEventListener('click', () => this.showImportDialog(container, 'collection'));
        container.querySelector('#pm-export-col-btn').addEventListener('click', () => this.showExportDialog('collection'));
        container.querySelector('#pm-check-updates-col-btn').addEventListener('click', () => this._manualCheckForUpdates(container, 'collection'));
        container.querySelector('#pm-update-all-col-btn').addEventListener('click', () => this._updateAllAvailable(container, 'collection'));
        container.querySelector('#pm-disable-all-col-btn').addEventListener('click', (e) => this._disableAllPlugins(container, 'collection', { el: e.currentTarget, isSwitch: false }));
        container.querySelector('#pm-enable-all-col-btn').addEventListener('click', (e) => this._enableAllPlugins(container, 'collection', { el: e.currentTarget, isSwitch: false }));
        this._bindListControls(container, 'app');
        this._bindListControls(container, 'collection');
        container.querySelector('#pm-export-workspace-btn').addEventListener('click', () => this.showExportDialog('all'));
        container.querySelector('#pm-import-workspace-btn').addEventListener('click', () => this.showImportDialog(container, 'all'));
        container.querySelector('#pm-export-workspace-themes-btn').addEventListener('click', () => this._exportAllThemes());

        // Setup collapsible Bulk Operations drawers
        const setupDrawer = (tabId) => {
            const btn = container.querySelector(`#pm-drawer-toggle-${tabId}`);
            const drawer = container.querySelector(`#pm-drawer-${tabId}`);
            if (btn && drawer) {
                btn.addEventListener('click', () => {
                    drawer.classList.toggle('pm-hidden');
                    if (drawer.classList.contains('pm-hidden')) {
                        btn.innerText = 'More ▾';
                        btn.classList.remove('active');
                    } else {
                        btn.innerText = 'More ▴';
                        btn.classList.add('active');
                    }
                });
            }
        };
        setupDrawer('global');
        setupDrawer('col');

        // Setup self-update badge if an update is available for the Plugins Manager itself
        const selfUpdateBtn = container.querySelector('#pm-header-self-update-btn');
        if (selfUpdateBtn) {
            const updates = this._readUpdateCache();
            const selfUpdateInfo = updates[this.getGuid()];
            if (selfUpdateInfo && selfUpdateInfo.version) {
                selfUpdateBtn.textContent = `Update Available (v${selfUpdateInfo.version})`;
                selfUpdateBtn.classList.remove('pm-hidden');

                selfUpdateBtn.addEventListener('click', async (e) => {
                    e.stopPropagation();
                    const p = this;
                    const conf = this.getConfiguration();
                    const sourceRepo = this._selfRepo;
                    try {
                        selfUpdateBtn.disabled = true;
                        selfUpdateBtn.textContent = 'Updating...';
                        await this.checkAndUpdatePlugin(p, conf, sourceRepo, selfUpdateBtn, container, selfUpdateInfo.version);
                    } catch (err) {
                        selfUpdateBtn.disabled = false;
                        selfUpdateBtn.textContent = `Update Available (v${selfUpdateInfo.version})`;
                    }
                });
            }
        }

        // Delegated handler for external links (replaces <a target="_blank"> which is blocked in some environments)
        container.addEventListener('click', (e) => {
            const linkEl = e.target.closest('[data-external-url]');
            if (linkEl) {
                e.preventDefault();
                this._openExternalLink(linkEl.dataset.externalUrl);
            }
        });
    }

    async _saveManagerSettings(overrides = {}) {
        const conf = this.getConfiguration();
        if (!conf.custom) conf.custom = {};

        if (overrides.githubPat !== undefined) {
            this.githubPat = overrides.githubPat;
            conf.custom.githubPat = overrides.githubPat;
            localStorage.removeItem('pm_github_pat_persistent');
        }
        if (overrides.communityRepos !== undefined) {
            this.communityRepos = overrides.communityRepos;
            conf.custom.community_repos = overrides.communityRepos;
            localStorage.setItem('pm_community_repos', overrides.communityRepos);
        }
        if (overrides.savedThemes !== undefined) {
            this._savedThemes = this._cloneJsonValue(Array.isArray(overrides.savedThemes) ? overrides.savedThemes : []);
            conf.custom.saved_themes = this._savedThemes;
        }
        if (overrides.autoExportEnabled !== undefined) {
            this._autoExportEnabled = !!overrides.autoExportEnabled;
            conf.custom.auto_export_enabled = !!overrides.autoExportEnabled;
            localStorage.setItem('pm_auto_export', this._autoExportEnabled ? 'true' : 'false');
        }

        try {
            const plugin = this.data.getPluginByGuid(this.getGuid());
            if (plugin) {
                await plugin.saveConfiguration(conf);
            } else if (typeof this.saveConfiguration === 'function') {
                await this.saveConfiguration(conf);
            }
        } catch (e) {
            console.warn('[Plugins Manager] Failed to persist manager settings:', e);
        }
    }

    async _renderWorkspaceSummary(container) {
        const summaryEl = container.querySelector('#pm-workspace-summary');
        if (!summaryEl) return;

        try {
            const allGlobals = await this.data.getAllGlobalPlugins();
            const allCollections = await this.data.getAllCollections();
            const themeCount = Array.isArray(this._savedThemes) ? this._savedThemes.length : 0;
            let autoBackupState;
            if (!this._autoExportEnabled) {
                autoBackupState = 'Auto-backup is disabled';
            } else if (this._autoExportMode === 'download' || (!this._autoExportCaps.hasFSAccess && !this._autoExportDirHandle)) {
                autoBackupState = this._autoExportMode === 'download'
                    ? 'Auto-backup is enabled (downloads on each change)'
                    : 'Auto-backup is enabled but needs a destination to be selected';
            } else if (this._autoExportDirHandle) {
                autoBackupState = `Auto-backup is enabled${this._autoExportDirName ? ` for ${this._autoExportDirName}` : ''}`;
            } else {
                autoBackupState = 'Auto-backup is enabled but needs a directory to be re-selected';
            }
            summaryEl.innerHTML = `
                <div class="pm-summary-grid">
                    <div class="pm-summary-card">
                        <strong>${allGlobals.length}</strong>
                        <span>Plugins</span>
                    </div>
                    <div class="pm-summary-card">
                        <strong>${allCollections.length}</strong>
                        <span>Collections</span>
                    </div>
                    <div class="pm-summary-card">
                        <strong>${themeCount}</strong>
                        <span>Saved Themes</span>
                    </div>
                </div>
                <div class="pm-summary-note">${this._escHtml(autoBackupState)}</div>
            `;
        } catch (e) {
            summaryEl.textContent = 'Unable to load workspace summary.';
        }
    }

    _getSectionMeta(typeFilter) {
        if (typeFilter === 'all') {
            return {
                label: 'Workspace',
                itemLabel: 'workspace items',
                importLabel: 'Workspace',
                warningLabel: 'plugins and collections'
            };
        }
        if (typeFilter === 'collection') {
            return {
                label: 'Collections',
                itemLabel: 'collections',
                importLabel: 'Collections',
                warningLabel: 'collections'
            };
        }
        return {
            label: 'Plugins',
            itemLabel: 'plugins',
            importLabel: 'Plugins',
            warningLabel: 'plugins'
        };
    }


    async loadDiscoverPlugins(container) {
        const listContainer = container.querySelector('#pm-discover-list');
        listContainer.innerHTML = 'Fetching community plugins...';

        // Reset search and filters
        const searchInput = container.querySelector('#pm-discover-search');
        if (searchInput) searchInput.value = '';
        container.querySelectorAll('.pm-filter-chip').forEach(c => c.classList.remove('active'));
        const allChip = container.querySelector('.pm-filter-chip[data-filter="all"]');
        if (allChip) allChip.classList.add('active');

        try {
            const repos = this.communityRepos.split('\n').map(u => u.trim()).filter(Boolean);
            if (repos.length === 0) {
                listContainer.innerHTML = '<div class="pm-card"><div class="pm-card-info"><p>No community repositories configured in Settings.</p></div></div>';
                return;
            }

            const items = [];

            for (const repoUrl of repos) {
                try {
                    // Security: only fetch HTTPS URLs to prevent data exfiltration
                    if (!repoUrl.startsWith('https://')) {
                        console.warn('[Plugins Manager] Skipping non-HTTPS community repo:', repoUrl);
                        continue;
                    }

                    // Pre-flight check to ensure we aren't fetching a massive file
                    const headRes = await fetch(repoUrl, { method: 'HEAD' });
                    if (!headRes.ok) continue;

                    const contentType = headRes.headers.get('content-type') || '';
                    if (contentType && !contentType.includes('text/plain') && !contentType.includes('text/markdown')) {
                        console.warn('[Plugins Manager] Skipping repo with invalid content-type:', repoUrl);
                        continue;
                    }

                    const contentLength = headRes.headers.get('content-length');
                    if (contentLength && parseInt(contentLength) > 10 * 1024 * 1024) { // 10MB limit
                        console.warn('[Plugins Manager] Skipping repo that is too large:', repoUrl);
                        continue;
                    }

                    const res = await fetch(repoUrl);
                    if (!res.ok) continue;
                    const text = await res.text();

                    const lines = text.split('\n');
                    let currentCategory = 'Other';
                    let foundPluginsSection = false;

                    for (let line of lines) {
                        line = line.trim();
                        if (line.startsWith('## Plugins') || line.startsWith('## Themes')) {
                            foundPluginsSection = true;
                        }
                        if (!foundPluginsSection) continue;

                        if (line.startsWith('## ') || line.startsWith('### ')) {
                            currentCategory = line.replace(/#/g, '').trim();
                        } else if (line.startsWith('- [')) {
                            const match = line.match(/- \[(.*?)\]\((.*?)\)(?: - (.*))?/);
                            if (match && match[2].startsWith('https://')) {
                                // Security: only accept HTTPS GitHub URLs in discover list
                                const itemUrl = match[2];
                                const catLower = currentCategory.toLowerCase();
                                let type = 'app';
                                if (catLower.includes('collection')) type = 'collection';
                                else if (catLower.includes('theme')) type = 'theme';

                                // For non-theme items, require valid GitHub URL
                                if (type !== 'theme' && !this._isValidGithubUrl(itemUrl)) continue;

                                items.push({
                                    name: match[1],
                                    url: itemUrl,
                                    description: match[3] || '',
                                    category: currentCategory,
                                    type: type,
                                    sourceRepo: repoUrl
                                });
                            }
                        }
                    }
                } catch (e) {
                    console.error("Error fetching discover repo", repoUrl, e);
                }
            }

            // Store items for filtering
            this._discoverItems = items;

            if (items.length === 0) {
                listContainer.innerHTML = '<div class="pm-card"><div class="pm-card-info"><p>No plugins found in the configured community repositories.</p></div></div>';
                return;
            }

            await this._renderDiscoverCards(container, items);

        } catch (err) {
            console.error(err);
            listContainer.innerHTML = "Error loading community plugins.";
        }
    }

    async _filterDiscoverList(container) {
        if (!this._discoverItems) return;

        const searchInput = container.querySelector('#pm-discover-search');
        const activeChip = container.querySelector('.pm-filter-chip.active');
        const searchTerm = (searchInput ? searchInput.value : '').toLowerCase().trim();
        const filterType = activeChip ? activeChip.dataset.filter : 'all';

        let filtered = this._discoverItems;

        // Apply category filter
        if (filterType !== 'all') {
            filtered = filtered.filter(item => item.type === filterType);
        }

        // Apply search filter (author is matched too, since cards now show it)
        if (searchTerm) {
            filtered = filtered.filter(item => {
                return item.name.toLowerCase().includes(searchTerm) ||
                    item.description.toLowerCase().includes(searchTerm) ||
                    item.category.toLowerCase().includes(searchTerm) ||
                    this._discoverAuthor(item).toLowerCase().includes(searchTerm);
            });
        }

        filtered = this._sortDiscoverItems(filtered, container);

        await this._renderDiscoverCards(container, filtered);
    }

    // Snap the install button's progress fill to 100%, then pop a small confetti burst.
    _finishInstallAnimation(btn) {
        if (!btn) return;
        btn.classList.add('pm-installing', 'pm-install-done');
        setTimeout(() => {
            this._confettiBurst(btn, 22);
            btn.classList.remove('pm-installing', 'pm-install-done');
        }, 200);
    }

    // Small dependency-free confetti pop from an element. Particles are plain spans animated
    // with rAF (gravity + spin) in a fixed overlay, torn down when they die.
    _confettiBurst(anchorEl, count = 22) {
        if (!anchorEl || !anchorEl.isConnected) return;

        const rect = anchorEl.getBoundingClientRect();
        const originX = rect.left + rect.width / 2;
        const originY = rect.top + rect.height / 2;

        const layer = document.createElement('div');
        layer.className = 'pm-confetti-layer';
        document.body.appendChild(layer);
        this._confettiLayers = this._confettiLayers || [];
        this._confettiLayers.push(layer);

        const colors = PM_CARD_COLORS.map(c => c.hex);
        const parts = [];
        for (let i = 0; i < count; i++) {
            const el = document.createElement('span');
            el.className = 'pm-confetti';
            el.style.background = colors[i % colors.length];
            el.style.left = `${originX}px`;
            el.style.top = `${originY}px`;
            layer.appendChild(el);

            // Fan upward and out.
            const angle = (-Math.PI / 2) + (Math.random() - 0.5) * (Math.PI * 0.95);
            const speed = 3 + Math.random() * 4.5;
            parts.push({
                el,
                x: 0, y: 0,
                vx: Math.cos(angle) * speed,
                vy: Math.sin(angle) * speed,
                rot: Math.random() * 360,
                vr: (Math.random() - 0.5) * 26,
                life: 0
            });
        }

        const GRAVITY = 0.22;
        const LIFESPAN = 70; // frames
        const step = () => {
            let alive = false;
            for (const p of parts) {
                if (p.life > LIFESPAN) continue;
                alive = true;
                p.life++;
                p.vy += GRAVITY;
                p.x += p.vx;
                p.y += p.vy;
                p.rot += p.vr;
                p.el.style.transform = `translate(${p.x}px, ${p.y}px) rotate(${p.rot}deg)`;
                p.el.style.opacity = String(Math.max(0, 1 - p.life / LIFESPAN));
            }
            if (alive) {
                requestAnimationFrame(step);
            } else {
                layer.remove();
                this._confettiLayers = (this._confettiLayers || []).filter(l => l !== layer);
            }
        };
        requestAnimationFrame(step);
    }

    _saveDiscoverMeta() {
        try { localStorage.setItem('pm_discover_meta', JSON.stringify(this._discoverMeta || {})); } catch (e) { }
    }

    // Read a community entry's plugin.json straight from raw.githubusercontent.com for its
    // version AND its declared icon. This avoids the GitHub *API* rate limit (60/hr
    // unauthenticated) — raw file reads aren't metered the same way. Cached for a day.
    async _fetchDiscoverMeta(item) {
        const key = item.url || '';
        if (!key || item.type === 'theme') return { version: '', icon: '' };

        const cached = this._discoverMeta[key];
        if (cached && (Date.now() - (cached.t || 0)) < 86400000) {
            return { version: cached.v || '', icon: cached.i || '' };
        }

        const m = key.match(/github\.com\/([^\/]+)\/([^\/#?]+)/i);
        if (!m) return { version: '', icon: '' };
        const owner = m[1];
        const repo = m[2].replace(/\.git$/, '');

        let version = '';
        let icon = '';
        for (const branch of ['main', 'master']) {
            try {
                const res = await fetch(`https://raw.githubusercontent.com/${owner}/${repo}/${branch}/plugin.json`);
                if (!res.ok) continue;
                const json = await res.json();
                version = json.version || json.ver || '';
                icon = json.icon || '';
                break;
            } catch (e) { /* try next branch */ }
        }

        this._discoverMeta[key] = { v: version, i: icon, t: Date.now() };
        this._saveDiscoverMeta();
        return { version, icon };
    }

    // After the cards paint, fill in each entry's real version + icon (a few at a time so we
    // don't fire ~35 requests at once). The plugin's own icon replaces the generic type glyph.
    async _hydrateDiscoverMeta(targets) {
        const CONCURRENCY = 5;
        for (let i = 0; i < targets.length; i += CONCURRENCY) {
            const batch = targets.slice(i, i + CONCURRENCY);
            await Promise.all(batch.map(async t => {
                let meta = { version: '', icon: '' };
                try {
                    meta = await this._fetchDiscoverMeta(t.item);
                } catch (e) { /* leave fallbacks in place */ }

                if (t.verEl && t.verEl.isConnected) {
                    if (meta.version) {
                        t.verEl.textContent = `v${meta.version}`;
                        t.verEl.classList.remove('pm-hidden');
                    } else {
                        t.verEl.remove();
                    }
                }

                // Feature the plugin's real icon when its repo declares one.
                if (meta.icon && t.iconEl && t.iconEl.isConnected) {
                    try {
                        const glyph = this.ui.createIcon(meta.icon);
                        t.iconEl.innerHTML = '';
                        t.iconEl.appendChild(glyph);
                    } catch (e) { /* keep the type fallback already rendered */ }
                }
            }));
        }
    }

    // Author for a discover entry = the GitHub repo owner (that's all the community README gives us).
    _discoverAuthor(item) {
        const attr = this._pluginAttribution({ __source_repo: item.url || '' });
        return attr ? attr.label : '';
    }

    _sortDiscoverItems(items, container) {
        const sortEl = container.querySelector('#pm-discover-sort');
        const sort = (sortEl && sortEl.value) || 'name';
        const byName = (a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
        const sorted = items.slice();
        sorted.sort((a, b) => {
            if (sort === 'author') {
                const aa = this._discoverAuthor(a);
                const ba = this._discoverAuthor(b);
                if (!aa && ba) return 1;
                if (aa && !ba) return -1;
                const c = aa.localeCompare(ba, undefined, { sensitivity: 'base' });
                if (c !== 0) return c;
            } else if (sort === 'type') {
                const c = (a.type || '').localeCompare(b.type || '');
                if (c !== 0) return c;
            }
            return byName(a, b);
        });
        return sorted;
    }

    async _renderDiscoverCards(container, items) {
        const listContainer = container.querySelector('#pm-discover-list');
        listContainer.innerHTML = '';

        // Build a set of installed plugin source URLs and names for quick lookup, plus the
        // installed version keyed the same way (the community README carries no version, and
        // fetching one per entry would blow GitHub's rate limit — so we show what we know).
        const installedSet = new Set();
        const installedVersions = new Map();
        const installedPlugins = new Map();
        try {
            const allGlobals = await this.data.getAllGlobalPlugins();
            const allCollections = await this.data.getAllCollections();
            [...allGlobals, ...allCollections].forEach(p => {
                try {
                    const conf = p.getExistingCodeAndConfig().json;
                    const ver = conf.version || conf.ver || '';
                    if (conf.__source_repo) {
                        installedSet.add(conf.__source_repo);
                        if (ver) installedVersions.set(conf.__source_repo, ver);
                    }
                    if (conf.name) {
                        installedSet.add(conf.name.toLowerCase());
                        if (ver) installedVersions.set(conf.name.toLowerCase(), ver);
                    }
                    // Keep the plugin object so Discover can uninstall it directly.
                    if (conf.__source_repo) installedPlugins.set(conf.__source_repo, p);
                    if (conf.name) installedPlugins.set(conf.name.toLowerCase(), p);
                } catch (e) { /* skip */ }
            });
        } catch (e) { /* couldn't read installed plugins, proceed without */ }

        if (items.length === 0) {
            listContainer.innerHTML = '<div class="pm-card pm-empty-state"><div class="pm-card-info"><p>No matching plugins or themes found.</p></div></div>';
            return;
        }

        const metaTargets = [];

        items.forEach(item => {
            const isCollection = item.type === 'collection';
            const isTheme = item.type === 'theme';
            const badgeText = isTheme ? 'Theme' : (isCollection ? 'Collection' : 'Plugin');
            const typeIcon = isTheme ? 'brush' : (isCollection ? 'folder' : 'puzzle');

            const isGithubSrc = this._isValidGithubUrl(item.url);
            const attr = this._pluginAttribution({ __source_repo: item.url || '' });
            const knownVersion = installedVersions.get(item.url) || installedVersions.get(item.name.toLowerCase()) || '';

            const card = document.createElement('div');
            card.className = 'pm-card';
            // Type is a light icon in the top-right corner; the hero icon is the plugin's own.
            card.dataset.ctype = item.type;
            card.innerHTML = `
                <span class="pm-card-typemark" data-type-mark title="${this._escHtml(badgeText)}" aria-label="${this._escHtml(badgeText)}"></span>
                <div class="pm-card-iconrow"><span class="pm-card-icon" data-discover-icon aria-hidden="true"></span></div>
                <div class="pm-card-info">
                    <h3 class="pm-card-title">
                        <span class="pm-card-name">${this._escHtml(item.name)}</span>
                        <span class="pm-badge pm-version-badge${knownVersion ? '' : ' pm-hidden'}" data-discover-ver>${knownVersion ? 'v' + this._escHtml(knownVersion) : ''}</span>
                        ${isGithubSrc ? `<span class="pm-gh-glyph pm-gh-mark" aria-label="GitHub source" title="GitHub source" data-external-url="${this._escHtml(item.url)}" role="link" tabindex="0"></span>` : ''}
                    </h3>
                    <div class="pm-card-attr" data-discover-attr></div>
                    <p>${this._escHtml(item.description)}</p>
                    <p class="pm-card-url-row"><span class="pm-card-url" data-external-url="${this._escHtml(item.url)}">${this._escHtml(item.url)}</span></p>
                </div>
                <div class="pm-card-actions"></div>
            `;

            // Light type mark, top-right.
            const markSlot = card.querySelector('[data-type-mark]');
            if (markSlot) {
                try { markSlot.appendChild(this.ui.createIcon(typeIcon)); } catch (e) { }
            }

            // Hero icon: the type glyph is only a placeholder until the real icon arrives.
            const dIconSlot = card.querySelector('[data-discover-icon]');
            if (dIconSlot) {
                try { dIconSlot.appendChild(this.ui.createIcon(typeIcon)); } catch (e) { }
            }

            const verEl = card.querySelector('[data-discover-ver]');
            metaTargets.push({ item, verEl: knownVersion ? null : verEl, iconEl: dIconSlot });

            const dAttrSlot = card.querySelector('[data-discover-attr]');
            if (dAttrSlot && attr) {
                dAttrSlot.appendChild(document.createTextNode('by '));
                const link = document.createElement('span');
                link.className = 'pm-card-attr-link';
                link.textContent = attr.label;
                if (attr.url) link.setAttribute('data-external-url', attr.url);
                dAttrSlot.appendChild(link);
            } else if (dAttrSlot) {
                dAttrSlot.remove();
            }

            const actionsContainer = card.querySelector('.pm-card-actions');

            const previewBtn = document.createElement('button');
            previewBtn.className = 'pm-btn';
            previewBtn.innerText = 'Preview';
            previewBtn.style.marginRight = '5px';

            previewBtn.addEventListener('click', () => {
                this.previewTheme(item.url);
            });

            if (isTheme) {
                actionsContainer.appendChild(previewBtn);
            }

            // Check if plugin is on the incompatible list
            const isIncompatible = !!this._incompatiblePlugins[item.url];
            const isInstalled = !isTheme && (installedSet.has(item.url) || installedSet.has(item.name.toLowerCase()));

            const installBtn = document.createElement('button');
            if (isIncompatible) {
                installBtn.className = 'pm-btn';
                installBtn.innerText = 'Incompatible';
                installBtn.disabled = true;
                installBtn.style.opacity = '0.5';
            } else if (isTheme) {
                const isSavedTheme = this._savedThemes.some(t => t.source === item.url || t.name === item.name);
                installBtn.className = isSavedTheme ? 'pm-btn' : 'pm-btn primary';
                installBtn.innerText = isSavedTheme ? 'Re-Save Theme' : 'Save Theme';
            } else if (isInstalled) {
                installBtn.className = 'pm-btn pm-btn-uninstall';
                installBtn.innerText = 'Uninstall';
            } else {
                installBtn.className = 'pm-btn primary';
                installBtn.innerText = 'Install';
            }

            // Installed → the button uninstalls (red tint) instead of installing.
            if (isInstalled && !isIncompatible && !isTheme) {
                installBtn.addEventListener('click', async () => {
                    const target = installedPlugins.get(item.url) || installedPlugins.get(item.name.toLowerCase());
                    if (!target) {
                        this.ui.addToaster({ title: 'Not found', message: `Couldn't locate an installed copy of ${item.name}.`, autoDestroyTime: 4000, dismissible: true });
                        return;
                    }
                    if (!await this._showConfirmModal('Uninstall plugin', `Uninstall ${item.name}?\nThis removes it from your workspace. You can install it again from Discover at any time.`, { confirmText: 'Uninstall', danger: true })) return;
                    try {
                        installBtn.innerText = 'Uninstalling...';
                        installBtn.disabled = true;
                        await target.trashPlugin();
                        this._autoExport();
                        this.ui.addToaster({ title: 'Uninstalled', message: `${item.name} has been removed.`, autoDestroyTime: 3000, dismissible: true });
                        this.loadPlugins(container);
                        this._filterDiscoverList(container);
                    } catch (e) {
                        installBtn.innerText = 'Uninstall';
                        installBtn.disabled = false;
                        this.ui.addToaster({ title: 'Uninstall Failed', message: e.message, autoDestroyTime: 5000, dismissible: true });
                    }
                });
                actionsContainer.appendChild(installBtn);
                listContainer.appendChild(card);
                return; // metaTargets was already registered when the card was built
            }

            // If incompatible, add a Recheck button first
            if (isIncompatible) {
                const recheckBtn = document.createElement('button');
                recheckBtn.className = 'pm-btn';
                recheckBtn.innerText = 'Recheck';
                recheckBtn.style.marginRight = '5px';
                recheckBtn.addEventListener('click', async () => {
                    recheckBtn.innerText = 'Checking...';
                    recheckBtn.disabled = true;
                    try {
                        if (isTheme) {
                            await this._fetchThemeCSS(item.url);
                        } else {
                            await this.fetchGithubRepo(item.url);
                        }
                        // Success — remove from incompatible list
                        delete this._incompatiblePlugins[item.url];
                        localStorage.setItem('pm_incompatible', JSON.stringify(this._incompatiblePlugins));
                        this.ui.addToaster({ title: "Compatible!", message: `${item.name} is now available to install.`, autoDestroyTime: 3000, dismissible: true });
                        this._renderDiscoverCards(container, items);
                    } catch (e) {
                        this.ui.addToaster({ title: "Still Incompatible", message: e.message, autoDestroyTime: 4000, dismissible: true });
                        recheckBtn.innerText = 'Recheck';
                        recheckBtn.disabled = false;
                    }
                });
                actionsContainer.appendChild(recheckBtn);
            }

            actionsContainer.appendChild(installBtn);

            if (!isIncompatible) {
                installBtn.addEventListener('click', async () => {
                    const originalText = installBtn.innerText;
                    installBtn.innerText = isTheme ? 'Fetching...' : 'Installing...';
                    installBtn.disabled = true;
                    installBtn.classList.add('pm-installing'); // left→right progress fill

                    try {
                        if (isTheme) {
                            const cssText = this._sanitizeCSS(await this._fetchThemeCSS(item.url));
                            const existingIdx = this._savedThemes.findIndex(t => t.source === item.url || t.name === item.name);

                            if (existingIdx > -1) {
                                this._savedThemes[existingIdx].css = cssText;
                                this._savedThemes[existingIdx].date = new Date().toISOString();
                            } else {
                                this._savedThemes.push({
                                    id: Date.now().toString(36),
                                    name: item.name,
                                    css: cssText,
                                    source: item.url,
                                    date: new Date().toISOString()
                                });
                            }
                            this._saveThemes();
                            this._autoExport();
                            this.ui.addToaster({ title: "Theme Saved!", message: `Saved "${item.name}" to your Theme Library.`, autoDestroyTime: 4000, dismissible: true });

                            installBtn.className = 'pm-btn';
                            installBtn.innerText = 'Saved';
                            this._finishInstallAnimation(installBtn);
                        } else {
                            const { json, js, css } = await this.fetchGithubRepo(item.url);
                            await this.installPlugin(json, js, { interactive: false, cssCode: css });
                            this.ui.addToaster({ title: `Successfully installed ${json.name}`, autoDestroyTime: 3000, dismissible: true });
                            installBtn.innerText = 'Installed';
                            this._finishInstallAnimation(installBtn);
                            this.loadPlugins(container);
                            // Re-render Discover so the entry flips to its red Uninstall button.
                            setTimeout(() => this._filterDiscoverList(container), 1400);
                        }
                    } catch (err) {
                        installBtn.classList.remove('pm-installing', 'pm-install-done');
                        // Add to incompatible list
                        this._incompatiblePlugins[item.url] = { name: item.name, error: err.message, date: new Date().toISOString() };
                        localStorage.setItem('pm_incompatible', JSON.stringify(this._incompatiblePlugins));
                        this.ui.addToaster({ title: "Failed", message: err.message, autoDestroyTime: 5000, dismissible: true });
                        // Re-render respecting current filter/search state
                        this._filterDiscoverList(container);
                    }
                });
            }

            listContainer.appendChild(card);
        });

        // Fill in versions in the background so the list paints immediately.
        this._hydrateDiscoverMeta(metaTargets);
    }

    async loadPlugins(container) {
        try {
            const globals = await this.data.getAllGlobalPlugins();
            const collections = await this.data.getAllCollections();

            // Build the normalized descriptor cache once; search/sort/filter re-render from it
            // without re-hitting the SDK.
            this._buildListCache('app', globals, container);
            this._buildListCache('collection', collections, container);

            // Update All reflects the full (unfiltered) set, so filtering can't hide it.
            this._refreshUpdateAllVisibility(container, 'app');
            this._refreshUpdateAllVisibility(container, 'collection');

            this._renderFilteredList(container, 'app');
            this._renderFilteredList(container, 'collection');
        } catch (err) {
            console.error(err);
            container.querySelector('#pm-global-list').innerHTML = "Error loading plugins.";
            container.querySelector('#pm-collections-list').innerHTML = "Error loading collections.";
        }
    }

    _saveDisabledPlugins() {
        localStorage.setItem('pm_disabled_plugins', JSON.stringify(this._disabledPlugins || {}));
    }

    _savePluginColors() {
        try { localStorage.setItem('pm_plugin_colors', JSON.stringify(this._pluginColors || {})); } catch (e) { }
    }

    // Stable key for a plugin's color: prefer the GitHub source repo (survives the
    // disable/enable reinstall that mints a new guid); fall back to the guid.
    _pluginColorKey(conf, guid) {
        return (conf && conf.__source_repo) || guid || '';
    }

    // Attribution for a plugin: an explicit author field if present, else the GitHub
    // repo owner. Returns { label, url } or null when there's nothing to show.
    _pluginAttribution(conf) {
        let author = (conf.author || conf.by || '').toString().trim();
        let url = '';
        const m = (conf.__source_repo || '').match(/github\.com\/([^\/]+)/i);
        if (m) {
            if (!author) author = m[1];
            url = 'https://github.com/' + m[1];
        }
        if (!author) return null;
        return { label: author, url };
    }

    // Apply (or clear) a card's color tint. Full-perimeter border + subtle bg wash (CSS).
    _applyCardColor(cardEl, hex) {
        if (!cardEl) return;
        if (hex) {
            cardEl.dataset.colored = '';
            cardEl.style.setProperty('--pm-card-accent', hex);
        } else {
            delete cardEl.dataset.colored;
            cardEl.style.removeProperty('--pm-card-accent');
        }
    }

    _updateColorBtn(btnEl, hex) {
        if (!btnEl) return;
        if (hex) {
            btnEl.dataset.hasColor = '';
            btnEl.style.setProperty('--pm-card-accent', hex);
            btnEl.title = 'Card color — click to change';
        } else {
            delete btnEl.dataset.hasColor;
            btnEl.style.removeProperty('--pm-card-accent');
            btnEl.title = 'Set a card color';
        }
    }

    _closeColorPopover() {
        if (this._colorPopover) {
            document.removeEventListener('mousedown', this._colorPopoverOutside, true);
            document.removeEventListener('keydown', this._colorPopoverKey, true);
            this._colorPopover.remove();
            this._colorPopover = null;
        }
    }

    // Small swatch popover anchored to a card's color button. Rendered to <body> (cards
    // are overflow:hidden). Use pm-tokens, NOT pm-container: the latter also carries the
    // panel's layout (width: 100%), which this position:fixed popover would inherit as 100%
    // of the viewport and stretch into a full-width bar.
    _openColorPopover(anchorEl, currentHex, onPick, colors) {
        this._closeColorPopover();

        const pop = document.createElement('div');
        pop.className = 'pm-tokens pm-color-popover';

        (colors || PM_CARD_COLORS).forEach(c => {
            const sw = document.createElement('button');
            sw.type = 'button';
            sw.className = 'pm-color-swatch';
            sw.style.background = c.hex;
            sw.title = c.name;
            sw.setAttribute('aria-label', c.name);
            if (currentHex && currentHex.toLowerCase() === c.hex.toLowerCase()) sw.dataset.selected = '';
            sw.addEventListener('click', () => { this._closeColorPopover(); onPick(c.hex); });
            pop.appendChild(sw);
        });

        const none = document.createElement('button');
        none.type = 'button';
        none.className = 'pm-color-swatch pm-color-none';
        none.title = 'No color';
        none.setAttribute('aria-label', 'No color');
        if (!currentHex) none.dataset.selected = '';
        none.addEventListener('click', () => { this._closeColorPopover(); onPick(null); });
        pop.appendChild(none);

        document.body.appendChild(pop);

        // Position under the button, flipping up / clamping to the viewport.
        const r = anchorEl.getBoundingClientRect();
        const pr = pop.getBoundingClientRect();
        let top = r.bottom + 6;
        if (top + pr.height > window.innerHeight - 8) top = r.top - pr.height - 6;
        let left = r.right - pr.width;
        if (left < 8) left = 8;
        pop.style.top = `${Math.max(8, top)}px`;
        pop.style.left = `${left}px`;

        this._colorPopover = pop;
        this._colorPopoverOutside = (e) => { if (!pop.contains(e.target) && e.target !== anchorEl) this._closeColorPopover(); };
        this._colorPopoverKey = (e) => { if (e.key === 'Escape') this._closeColorPopover(); };
        setTimeout(() => {
            document.addEventListener('mousedown', this._colorPopoverOutside, true);
            document.addEventListener('keydown', this._colorPopoverKey, true);
        }, 0);
    }

    // Build an accessible on/off switch (role="switch"). Returns the <button> element.
    // onToggle receives the switch element so callers can drive its pending/disabled state.
    _createToggleSwitch({ on, disabled = false, title = '', ariaLabel = '', onToggle } = {}) {
        const sw = document.createElement('button');
        sw.type = 'button';
        sw.className = 'pm-switch';
        sw.setAttribute('role', 'switch');
        sw.setAttribute('aria-checked', on ? 'true' : 'false');
        if (title) sw.title = title;
        if (ariaLabel) sw.setAttribute('aria-label', ariaLabel);
        sw.disabled = !!disabled;
        const thumb = document.createElement('span');
        thumb.className = 'pm-switch-thumb';
        thumb.setAttribute('aria-hidden', 'true');
        sw.appendChild(thumb);
        if (onToggle && !disabled) {
            sw.addEventListener('click', () => {
                if (sw.disabled) return;
                onToggle(sw);
            });
        }
        return sw;
    }

    _getDisabledPluginsForType(typeFilter) {
        const allDisabled = Object.values(this._disabledPlugins || {});
        return allDisabled.filter(item => {
            // Valid if it can be restored: a GitHub source to re-fetch, or stashed local code.
            if (!item || (!item.sourceRepo && !item.code)) return false;
            const type = (item.type || '').toLowerCase();
            const normalized = (type === 'global' || type === 'app') ? 'app' : (type === 'collection' ? 'collection' : 'app');
            return normalized === typeFilter;
        });
    }

    // Confirm-free core: stash what's needed to bring the plugin back, then trash it.
    // GitHub plugins stash a repo pointer (re-fetched on enable); LOCAL plugins have no
    // repo, so we stash their actual code + CSS + config to reinstall from. Throws on failure.
    // Shared by the single-card toggle and the bulk "All Off" / Safe Mode paths.
    async _disablePluginCore(pluginObj, conf) {
        const guid = pluginObj.getGuid();
        const sourceRepo = conf.__source_repo || '';
        // Map key: repo for GitHub plugins (stable across guid churn), else a local guid key.
        const key = sourceRepo || ('local:' + guid);

        const rawType = (conf.type || '').toLowerCase();
        const normalizedType = (rawType === 'collection') ? 'collection' : 'app';

        const entry = {
            key,
            guid,
            name: conf.name || 'Unnamed Plugin',
            type: normalizedType,
            sourceRepo: sourceRepo || null,
            sourceFiles: conf.__source_files || null,
            version: conf.version || conf.ver || '',
            icon: conf.icon || null,
            // Kept so disabled cards stay searchable/sortable by description + author.
            description: conf.description || '',
            author: (conf.author || conf.by || '') || null,
            custom: conf.custom !== undefined ? this._cloneJsonValue(conf.custom) : undefined,
            dateDisabled: new Date().toISOString()
        };

        // Local plugin: no upstream to reinstall from, so keep the actual code + CSS + config.
        if (!sourceRepo) {
            const cc = pluginObj.getExistingCodeAndConfig();
            entry.code = cc.code || '';
            entry.css = cc.css || '';
            entry.json = this._cloneJsonValue(cc.json);
        }

        this._disabledPlugins[key] = entry;
        this._saveDisabledPlugins();

        await pluginObj.trashPlugin();
    }

    // Confirm-free core: reinstall a disabled plugin. GitHub plugins re-fetch from their repo;
    // LOCAL plugins reinstall from the stashed code/CSS/config. Restores saved settings either
    // way so configuration survives the off/on cycle. Throws on failure.
    async _enableDisabledPluginCore(disabledPlugin) {
        const key = disabledPlugin.key || disabledPlugin.sourceRepo;
        let name;

        if (disabledPlugin.sourceRepo) {
            const { json, js, css } = await this.fetchGithubRepo(disabledPlugin.sourceRepo, { sourceFiles: disabledPlugin.sourceFiles });
            const hasRestoredCustom = disabledPlugin.custom !== undefined;
            if (hasRestoredCustom) json.custom = this._cloneJsonValue(disabledPlugin.custom);
            await this.installPlugin(json, js, { interactive: false, cssCode: css, allowRestoredCustom: hasRestoredCustom });
            name = json.name || disabledPlugin.name;
        } else {
            // Local plugin: reinstall from the stash (no network).
            const json = this._cloneJsonValue(disabledPlugin.json) || {};
            const hasRestoredCustom = disabledPlugin.custom !== undefined;
            if (hasRestoredCustom) json.custom = this._cloneJsonValue(disabledPlugin.custom);
            await this.installPlugin(json, disabledPlugin.code || '', { interactive: false, cssCode: disabledPlugin.css || '', allowRestoredCustom: hasRestoredCustom });
            name = (json && json.name) || disabledPlugin.name;
        }

        delete this._disabledPlugins[key];
        this._saveDisabledPlugins();
        return name;
    }

    async _disablePlugin(pluginObj, conf, panelContainer) {
        const isLocal = !conf.__source_repo;
        const pluginName = conf.name || 'this plugin';
        const note = isLocal
            ? 'This removes it from the Plugins panel. Its code is saved here so you can re-enable it anytime.'
            : 'This removes it from the official Plugins panel. You can re-enable it later from Plugins Manager.';
        if (!await this._showConfirmModal('Disable plugin', `Disable ${pluginName}?\n${note}`, { confirmText: 'Disable', danger: true })) {
            return;
        }

        await this._disablePluginCore(pluginObj, conf);
        this._autoExport();
        this.ui.addToaster({ title: 'Plugin disabled', message: `${pluginName} can be re-enabled anytime.`, dismissible: true, autoDestroyTime: 3500 });
        this.loadPlugins(panelContainer);
    }

    async _enableDisabledPlugin(disabledPlugin, panelContainer, toggleEl) {
        try {
            if (toggleEl) {
                toggleEl.disabled = true;
                toggleEl.setAttribute('aria-busy', 'true');
            }

            const name = await this._enableDisabledPluginCore(disabledPlugin);

            this.ui.addToaster({ title: 'Plugin enabled', message: `${name} reinstalled.`, dismissible: true, autoDestroyTime: 3500 });
            this.loadPlugins(panelContainer);
        } catch (e) {
            if (toggleEl) {
                toggleEl.disabled = false;
                toggleEl.removeAttribute('aria-busy');
            }
            this.ui.addToaster({ title: 'Enable Failed', message: e.message, dismissible: true, autoDestroyTime: 5000 });
        }
    }

    // Put a bulk-action control into a loading state and return { progress, end }.
    // Text buttons show a spinner + "(i/total)" progress; switches just go aria-busy.
    _bulkBusyStart(el, isSwitch) {
        if (!el) return { progress() { }, end() { } };
        if (isSwitch) {
            el.disabled = true;
            el.setAttribute('aria-busy', 'true');
            return { progress() { }, end() { el.disabled = false; el.removeAttribute('aria-busy'); } };
        }
        const original = el.textContent;
        el.disabled = true;
        el.textContent = '';
        try { el.appendChild(this.ui.createIcon('loader')); } catch (e) { }
        return {
            progress: (txt) => { el.textContent = txt; },
            end: () => { el.textContent = original; el.disabled = false; }
        };
    }

    _bulkSummaryToaster(verb, successCount, failedNames) {
        const parts = [`${verb}: ${successCount}`];
        if (failedNames.length) parts.push(`Failed: ${failedNames.join(', ')}`);
        this.ui.addToaster({
            title: failedNames.length ? `${verb} (with errors)` : `${verb} complete`,
            message: parts.join('. '),
            dismissible: true,
            autoDestroyTime: failedNames.length ? 8000 : 5000
        });
    }

    // Bulk "All Off". scope: 'app' | 'collection' | 'all'. Never disables the Plugins
    // Manager itself (that would close this panel). Returns { count, cancelled }.
    async _disableAllPlugins(container, scope, control) {
        let plugins = [];
        try {
            if (scope === 'app' || scope === 'all') plugins = plugins.concat(await this.data.getAllGlobalPlugins());
            if (scope === 'collection' || scope === 'all') plugins = plugins.concat(await this.data.getAllCollections());
        } catch (e) { }

        // Everything except the Plugins Manager itself (disabling self would close the panel).
        const targets = plugins.filter(p => {
            try {
                return p.getGuid() !== this.getGuid();
            } catch (e) { return false; }
        });

        if (targets.length === 0) {
            this.ui.addToaster({ title: 'Nothing to turn off', message: 'No other plugins are currently enabled.', dismissible: true, autoDestroyTime: 4000 });
            return { count: 0 };
        }

        if (!await this._showConfirmModal('Turn all off', `Turn OFF ${targets.length} plugin${targets.length === 1 ? '' : 's'}?\nEach is removed from the Plugins panel (its settings are preserved) and can be turned back on anytime.`, { confirmText: 'Turn all off', danger: true })) {
            return { cancelled: true };
        }

        const busy = this._bulkBusyStart(control && control.el, control && control.isSwitch);
        let successCount = 0;
        const failedNames = [];
        const total = targets.length;
        for (let i = 0; i < targets.length; i++) {
            const p = targets[i];
            busy.progress(`Turning off… (${i + 1}/${total})`);
            try {
                const conf = p.getExistingCodeAndConfig().json;
                await this._disablePluginCore(p, conf);
                successCount++;
            } catch (e) {
                console.error(e);
                try { failedNames.push(p.getExistingCodeAndConfig().json.name || 'Unknown'); }
                catch (e2) { failedNames.push(p.getGuid()); }
            }
        }

        this._autoExport();
        busy.end();
        this.loadPlugins(container);
        this._bulkSummaryToaster('Turned off', successCount, failedNames);
        return { count: successCount };
    }

    // Bulk "All On": re-enable every plugin currently disabled within scope.
    async _enableAllPlugins(container, scope, control) {
        const disabled = (scope === 'all')
            ? Object.values(this._disabledPlugins || {}).filter(d => d && (d.sourceRepo || d.code))
            : this._getDisabledPluginsForType(scope);

        if (disabled.length === 0) {
            this.ui.addToaster({ title: 'Nothing to turn on', message: 'No disabled plugins to re-enable.', dismissible: true, autoDestroyTime: 4000 });
            return { count: 0 };
        }

        if (!await this._showConfirmModal('Turn all on', `Turn ON ${disabled.length} plugin${disabled.length === 1 ? '' : 's'}?\nEach is reinstalled from its source (network required).`, { confirmText: 'Turn all on' })) {
            return { cancelled: true };
        }

        const busy = this._bulkBusyStart(control && control.el, control && control.isSwitch);
        let successCount = 0;
        const failedNames = [];
        const total = disabled.length;
        for (let i = 0; i < disabled.length; i++) {
            const d = disabled[i];
            busy.progress(`Turning on… (${i + 1}/${total})`);
            try {
                await this._enableDisabledPluginCore(d);
                successCount++;
            } catch (e) {
                console.error(e);
                failedNames.push(d.name || d.sourceRepo || 'Unknown');
            }
        }

        this._autoExport();
        busy.end();
        this.loadPlugins(container);
        this._bulkSummaryToaster('Turned on', successCount, failedNames);
        return { count: successCount };
    }

    // Build one disabled "ghost" card. Returns the element; the caller appends it.
    _renderGhostCard(disabled, panelContainer, typeFilter) {
        const disabledDate = disabled.dateDisabled ? new Date(disabled.dateDisabled).toLocaleDateString() : 'Unknown date';
        const card = document.createElement('div');
        card.className = 'pm-card pm-card-disabled';
        card.innerHTML = `
            <div class="pm-card-iconrow"><span class="pm-card-icon" data-disabled-icon aria-hidden="true"></span></div>
            <div class="pm-card-info">
                <h3 class="pm-card-title">
                    <span class="pm-card-name">${this._escHtml(disabled.name || 'Unnamed Plugin')}</span>
                    ${disabled.version ? `<span class="pm-badge pm-version-badge">v${this._escHtml(disabled.version)}</span>` : ''}
                    <span class="pm-badge">Disabled</span>
                </h3>
                <p>Disabled on ${this._escHtml(disabledDate)}. Re-enable to reinstall in the official Plugins panel.</p>
                ${disabled.sourceRepo ? `<p class="pm-card-url-row"><span class="pm-card-url" data-external-url="${this._escHtml(disabled.sourceRepo)}">${this._escHtml(disabled.sourceRepo)}</span></p>` : ''}
            </div>
            <div class="pm-card-actions"></div>
        `;

        const disabledIconSlot = card.querySelector('[data-disabled-icon]');
        if (disabledIconSlot) {
            try {
                disabledIconSlot.appendChild(this.ui.createIcon(disabled.icon || 'box'));
            } catch (e) {
                try { disabledIconSlot.appendChild(this.ui.createIcon('box')); } catch (e2) { }
            }
        }

        const actionsContainer = card.querySelector('.pm-card-actions');
        // Disabled toggle. OFF = disabled; turning ON reinstalls (GitHub, or stashed local code).
        const disabledSwitch = this._createToggleSwitch({
            on: false,
            title: disabled.sourceRepo ? 'Disabled — turn on to enable (reinstall from GitHub)' : 'Disabled — turn on to enable (restore saved code)',
            ariaLabel: `${disabled.name || 'Plugin'} disabled. Turn on to enable.`,
            onToggle: (sw) => this._enableDisabledPlugin(disabled, panelContainer, sw)
        });
        // Appended LAST (below), not here: the switch is pinned to the far right of the row via
        // margin-left:auto, which only lands correctly if it is the final child — same order as
        // the live card, so both card types read identically.

        // Disabled plugins can be color-tagged too (same key, so the tag survives re-enabling).
        const actionsWrapper = document.createElement('div');
        actionsWrapper.className = 'pm-card-actions-wrapper';
        this._attachColorButton(card, actionsWrapper, this._ghostColorKey(disabled), panelContainer, typeFilter);
        actionsContainer.appendChild(actionsWrapper);

        // Responsive overflow menu trigger button for small screens
        const triggerBtn = document.createElement('button');
        triggerBtn.className = 'pm-btn pm-card-overflow-trigger';
        triggerBtn.title = 'More Actions';
        try {
            triggerBtn.appendChild(this.ui.createIcon('dots-vertical'));
        } catch (e) {
            triggerBtn.textContent = '⋮';
        }
        actionsContainer.appendChild(triggerBtn);

        triggerBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            const isOpen = actionsWrapper.classList.contains('pm-open');
            document.querySelectorAll('.pm-card-actions-wrapper.pm-open').forEach(el => {
                el.classList.remove('pm-open');
            });
            document.querySelectorAll('.pm-card.pm-menu-open').forEach(el => {
                el.classList.remove('pm-menu-open');
            });
            if (!isOpen) {
                actionsWrapper.classList.add('pm-open');
                card.classList.add('pm-menu-open');
            }
        });
        actionsWrapper.addEventListener('click', () => {
            actionsWrapper.classList.remove('pm-open');
            card.classList.remove('pm-menu-open');
        });

        // Last child, so it pins to the far right of the row (see .pm-card-actions > .pm-switch).
        actionsContainer.appendChild(disabledSwitch);

        return card;
    }

    _ghostColorKey(disabled) {
        return disabled.sourceRepo || disabled.guid || '';
    }

    _ghostColorHex(disabled) {
        return this._pluginColors[this._ghostColorKey(disabled)] || null;
    }

    // The color key for a normalized list descriptor (live or ghost).
    _itemColorKey(it) {
        return it.kind === 'live'
            ? this._pluginColorKey(it.conf, it.plugin.getGuid())
            : this._ghostColorKey(it.disabled);
    }

    // Attach the color-tag button to a card's action row and paint the card's current tint.
    // Shared by live and disabled cards so both can be color-tagged.
    _attachColorButton(card, actionsContainer, colorKey, panelContainer, typeFilter) {
        const storedHex = this._pluginColors[colorKey] || null;

        const colorBtn = document.createElement('button');
        colorBtn.type = 'button';
        colorBtn.className = 'pm-color-btn pm-btn';

        const dot = document.createElement('span');
        dot.className = 'pm-color-btn-dot';
        colorBtn.appendChild(dot);

        const label = document.createElement('span');
        label.className = 'pm-btn-label';
        label.textContent = 'Card Color';
        colorBtn.appendChild(label);

        this._updateColorBtn(colorBtn, storedHex);
        actionsContainer.appendChild(colorBtn);

        colorBtn.addEventListener('click', () => {
            if (this._colorPopover) { this._closeColorPopover(); return; }
            this._openColorPopover(colorBtn, this._pluginColors[colorKey] || null, (hex) => {
                if (hex) this._pluginColors[colorKey] = hex;
                else delete this._pluginColors[colorKey];
                this._savePluginColors();

                // Keep the descriptor cache in step so color sort + the color filter row
                // reflect the change immediately instead of going stale until a reload.
                const items = this._listCache[typeFilter] || [];
                const desc = items.find(it => this._itemColorKey(it) === colorKey);
                if (desc) desc.colorHex = hex || null;

                this._renderFilteredList(panelContainer, typeFilter);
            });
        });

        this._applyCardColor(card, storedHex);
    }

    // Build one live plugin card. Returns the element; the caller appends it.
    _renderLiveCard(p, conf, panelContainer, availableUpdates, typeFilter) {
        const sourceRepo = conf.__source_repo || '';

        const card = document.createElement('div');
        card.className = 'pm-card';
        card.innerHTML = `
                <div class="pm-card-iconrow"><span class="pm-card-icon" id="pm-icon-${p.getGuid()}" aria-hidden="true"></span></div>
                <div class="pm-card-info">
                    <h3 id="pm-title-${p.getGuid()}" class="pm-card-title">
                        <span class="pm-card-name">${this._escHtml(conf.name || 'Unnamed Plugin')}</span>
                        <span class="pm-badge pm-version-badge" id="vbadge-${p.getGuid()}">v${this._escHtml(conf.version || conf.ver || '0.0.0')}</span>
                        ${sourceRepo ? `<span class="pm-gh-glyph pm-gh-mark" aria-label="GitHub source" title="GitHub source" data-external-url="${this._escHtml(sourceRepo)}" role="link" tabindex="0"></span>` : ''}
                    </h3>
                    <div class="pm-card-attr" id="pm-attr-${p.getGuid()}"></div>
                    <p>${this._escHtml(conf.description || 'No description')}</p>
                    ${sourceRepo ? `<p class="pm-card-url-row"><span class="pm-card-url" data-external-url="${this._escHtml(sourceRepo)}">${this._escHtml(sourceRepo)}</span></p>` : ''}
                </div>
                <div class="pm-card-actions"></div>
            `;

        // Add the plugin's own icon (Tabler name from its manifest; falls back to 'box')
        const iconSlot = card.querySelector(`#pm-icon-${p.getGuid()}`);
        if (iconSlot) {
            try {
                iconSlot.appendChild(this.ui.createIcon(conf.icon || 'box'));
            } catch (e) {
                try { iconSlot.appendChild(this.ui.createIcon('box')); } catch (e2) { }
            }
        }

        // Attribution line under the title (author, or GitHub repo owner).
        const attrSlot = card.querySelector(`#pm-attr-${p.getGuid()}`);
        const attr = this._pluginAttribution(conf);
        if (attrSlot && attr) {
            attrSlot.appendChild(document.createTextNode('by '));
            if (attr.url) {
                const link = document.createElement('span');
                link.className = 'pm-card-attr-link';
                link.textContent = attr.label;
                link.setAttribute('data-external-url', attr.url);
                attrSlot.appendChild(link);
            } else {
                attrSlot.appendChild(document.createTextNode(attr.label));
            }
        } else if (attrSlot) {
            attrSlot.remove();
        }

        const actionsContainer = card.querySelector('.pm-card-actions');

        // Update availability (cache passed in — read once per render, not per card)
        const updates = availableUpdates || {};
        const updateInfo = updates[p.getGuid()];
        const remoteVersion = updateInfo ? updateInfo.version : null;
        const installedVersion = conf.version || conf.ver;

        if (remoteVersion && remoteVersion !== installedVersion) {
            card.classList.add('pm-card-upgradeable');
            const badge = card.querySelector(`#vbadge-${p.getGuid()}`);
            if (badge) {
                badge.innerText = `Update Available (v${remoteVersion})`;
                badge.classList.add('update');
            }
        }

        // Add Native Update Button
        let updateBtn = null;
        let reinstallBtn = null;
        if (sourceRepo) {
            // Known update version (string) if background checker flagged one
            const knownUpdate = (remoteVersion && remoteVersion !== installedVersion) ? remoteVersion : null;

            updateBtn = document.createElement('button');
            updateBtn.className = knownUpdate ? 'pm-btn pm-btn-update update-btn' : 'pm-btn pm-btn-update';

            const labelSpan = document.createElement('span');
            labelSpan.className = 'pm-btn-label';
            labelSpan.textContent = knownUpdate ? `Update (v${knownUpdate})` : 'Check Update';

            if (knownUpdate) {
                updateBtn.title = `Update to v${knownUpdate}`;
                updateBtn.appendChild(this.ui.createIcon('arrow-up'));
                updateBtn.classList.add('update-btn');
            } else {
                updateBtn.title = 'Check Update';
                updateBtn.appendChild(this.ui.createIcon('refresh'));
            }
            updateBtn.appendChild(labelSpan);

            const pendingVersion = knownUpdate;
            updateBtn.addEventListener('click', () => this.checkAndUpdatePlugin(p, conf, sourceRepo, updateBtn, panelContainer, pendingVersion));

            // Reinstall button — force re-download from source without version check
            reinstallBtn = document.createElement('button');
            reinstallBtn.className = 'pm-btn pm-btn-reinstall';
            reinstallBtn.title = 'Reinstall from source (force overwrite)';
            reinstallBtn.appendChild(this.ui.createIcon('download'));
            const reinstallLabel = document.createElement('span');
            reinstallLabel.className = 'pm-btn-label';
            reinstallLabel.textContent = 'Reinstall';
            reinstallBtn.appendChild(reinstallLabel);

            reinstallBtn.addEventListener('click', async () => {
                if (!await this._showConfirmModal('Reinstall from source', `Reinstall ${conf.name} from source?\nThis will overwrite local code with the latest from GitHub, even if the version number hasn't changed.`, { confirmText: 'Reinstall', danger: true })) return;
                try {
                    reinstallBtn.innerHTML = '';
                    reinstallBtn.appendChild(this.ui.createIcon('loader'));
                    const reinstallLoadLabel = document.createElement('span');
                    reinstallLoadLabel.className = 'pm-btn-label';
                    reinstallLoadLabel.textContent = 'Reinstalling...';
                    reinstallBtn.appendChild(reinstallLoadLabel);
                    reinstallBtn.disabled = true;

                    const { json: remoteJson, js: remoteJs, css: remoteCss } = await this.fetchGithubRepo(sourceRepo, { sourceFiles: conf.__source_files });
                    this._validatePluginJS(remoteJson.name, remoteJs);
                    const sanitizedConf = this._sanitizePluginConfig(remoteJson);
                    if (conf.custom !== undefined) {
                        sanitizedConf.custom = this._cloneJsonValue(conf.custom);
                    }
                    this._ensurePluginIdentity(sanitizedConf, conf);

                    const isSelfUpdate = p.getGuid() === this.getGuid();

                    if (remoteCss) {
                        const sanitizedCSS = this._sanitizeCSS(remoteCss);
                        await p.saveCSS(sanitizedCSS);
                    }

                    if (isSelfUpdate) {
                        const panel = this.ui.getActivePanel();
                        if (panel) this.ui.closePanel(panel);
                        localStorage.setItem('pm_self_update_pending', 'true');
                    } else {
                        this._autoExport(); // fire-and-forget
                        this.ui.addToaster({ title: 'Reinstalled', message: `${conf.name} has been reinstalled from source.`, autoDestroyTime: 3000, dismissible: true });
                    }

                    await p.savePlugin(sanitizedConf, remoteJs);

                    if (!isSelfUpdate) {
                        this.loadPlugins(panelContainer);
                    }
                } catch (e) {
                    this.ui.addToaster({ title: 'Reinstall Failed', message: e.message, autoDestroyTime: 5000, dismissible: true });
                    reinstallBtn.innerHTML = '';
                    reinstallBtn.appendChild(this.ui.createIcon('download-cloud'));
                    const reinstallFailLabel = document.createElement('span');
                    reinstallFailLabel.className = 'pm-btn-label';
                    reinstallFailLabel.textContent = 'Reinstall';
                    reinstallBtn.appendChild(reinstallFailLabel);
                    reinstallBtn.disabled = false;
                }
            });
        }

        // Always offer to link or edit a GitHub repo for updates
        const linkBtn = document.createElement('button');
        linkBtn.className = 'pm-btn pm-btn-link';
        linkBtn.title = sourceRepo ? 'Edit GitHub repo link' : 'Link to a GitHub repo for updates';
        linkBtn.appendChild(this.ui.createIcon('link'));
        const linkLabel = document.createElement('span');
        linkLabel.className = 'pm-btn-label';
        linkLabel.textContent = 'Link Repository';
        linkBtn.appendChild(linkLabel);

        linkBtn.addEventListener('click', async () => {
            const repoUrl = await this._showPromptModal('Link GitHub Repository', 'Enter the GitHub repo URL for this plugin:', sourceRepo || '');
            if (repoUrl === null) return; // cancelled
            if (repoUrl === '') {
                // Remove link
                if (!await this._showConfirmModal('Clear repository link', 'Clear the repository link? This will disable updates.', { confirmText: 'Clear link', danger: true })) return;
            } else if (!this._isValidGithubUrl(repoUrl)) {
                this.ui.addToaster({ title: 'Invalid URL', message: 'Please enter a valid github.com URL.', autoDestroyTime: 4000, dismissible: true });
                return;
            }

            try {
                const { json: currentJson, code: currentCode } = p.getExistingCodeAndConfig();
                currentJson.__source_repo = repoUrl;
                await p.savePlugin(currentJson, currentCode);
                this.ui.addToaster({ title: 'Repo Updated', message: repoUrl ? `${conf.name} linked to ${repoUrl}.` : `${conf.name} link removed.`, autoDestroyTime: 4000, dismissible: true });
                this.loadPlugins(panelContainer);
            } catch (e) {
                this.ui.addToaster({ title: 'Update Failed', message: e.message, autoDestroyTime: 5000, dismissible: true });
            }
        });

        // Add Native Delete Button
        const deleteBtn = document.createElement('button');
        deleteBtn.className = 'pm-btn danger pm-btn-delete';
        deleteBtn.title = 'Delete Plugin';
        deleteBtn.appendChild(this.ui.createIcon('trash')); // trash usually exists in Thymer/Lucide
        const deleteLabel = document.createElement('span');
        deleteLabel.className = 'pm-btn-label';
        deleteLabel.textContent = 'Delete';
        deleteBtn.appendChild(deleteLabel);

        deleteBtn.addEventListener('click', async () => {
            if (await this._showConfirmModal('Delete plugin', `Are you sure you want to delete ${conf.name}?`, { confirmText: 'Delete', danger: true })) {
                await p.trashPlugin();
                this._autoExport(); // fire-and-forget
                this.ui.addToaster({ title: "Plugin deleted", dismissible: true, autoDestroyTime: 3000 });
                this.loadPlugins(panelContainer);
            }
        });

        // Collapsible wrapper for the secondary action buttons (Update, Reinstall, Link, Delete, Color)
        const actionsWrapper = document.createElement('div');
        actionsWrapper.className = 'pm-card-actions-wrapper';
        if (updateBtn) actionsWrapper.appendChild(updateBtn);
        if (reinstallBtn) actionsWrapper.appendChild(reinstallBtn);
        actionsWrapper.appendChild(linkBtn);
        actionsWrapper.appendChild(deleteBtn);
        this._attachColorButton(card, actionsWrapper, this._pluginColorKey(conf, p.getGuid()), panelContainer, typeFilter);
        actionsContainer.appendChild(actionsWrapper);

        // Responsive overflow menu trigger button for small screens
        const triggerBtn = document.createElement('button');
        triggerBtn.className = 'pm-btn pm-card-overflow-trigger';
        triggerBtn.title = 'More Actions';
        try {
            triggerBtn.appendChild(this.ui.createIcon('dots-vertical'));
        } catch (e) {
            triggerBtn.textContent = '⋮';
        }
        actionsContainer.appendChild(triggerBtn);

        triggerBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            const isOpen = actionsWrapper.classList.contains('pm-open');
            document.querySelectorAll('.pm-card-actions-wrapper.pm-open').forEach(el => {
                el.classList.remove('pm-open');
            });
            document.querySelectorAll('.pm-card.pm-menu-open').forEach(el => {
                el.classList.remove('pm-menu-open');
            });
            if (!isOpen) {
                actionsWrapper.classList.add('pm-open');
                card.classList.add('pm-menu-open');
            }
        });
        actionsWrapper.addEventListener('click', () => {
            actionsWrapper.classList.remove('pm-open');
            card.classList.remove('pm-menu-open');
        });

        // Enabled/disabled toggle. ON = enabled. Works for GitHub and local plugins
        // (local code is stashed on disable so it can be restored on enable).
        const enabledSwitch = this._createToggleSwitch({
            on: true,
            title: 'Enabled — turn off to disable (remove from Plugins panel)',
            ariaLabel: `${conf.name || 'Plugin'} enabled. Turn off to disable.`,
            onToggle: () => this._disablePlugin(p, conf, panelContainer)
        });
        actionsContainer.appendChild(enabledSwitch);

        return card;
    }

    // --- List search / sort / filter ---

    _defaultListState() {
        return { q: '', sort: 'name', status: 'all', color: null, view: 'grid' };
    }

    // Wire one tab's search box, sort dropdown and status chips. Chips are scoped to this
    // tab's own group (class .pm-chip, NOT .pm-filter-chip) so the Discover tab's
    // container-wide .pm-filter-chip handler keeps working.
    _bindListControls(container, typeFilter) {
        const suffix = typeFilter === 'app' ? 'global' : 'col';
        const state = this._listState[typeFilter];
        this._searchTimers = this._searchTimers || {};

        const searchEl = container.querySelector(`#pm-search-${suffix}`);
        if (searchEl) {
            searchEl.value = state.q || '';
            searchEl.addEventListener('input', () => {
                clearTimeout(this._searchTimers[typeFilter]);
                this._searchTimers[typeFilter] = setTimeout(() => {
                    state.q = searchEl.value;
                    this._renderFilteredList(container, typeFilter);
                }, 130);
            });
        }

        const sortEl = container.querySelector(`#pm-sort-${suffix}`);
        if (sortEl) {
            sortEl.value = state.sort;
            sortEl.addEventListener('change', () => {
                state.sort = sortEl.value;
                this._saveListState();
                this._renderFilteredList(container, typeFilter);
            });
        }

        const statusGroup = container.querySelector(`#pm-status-${suffix}`);
        if (statusGroup) {
            statusGroup.querySelectorAll('.pm-chip').forEach(chip => {
                chip.classList.toggle('active', chip.dataset.status === state.status);
                chip.addEventListener('click', (e) => {
                    const btn = e.currentTarget;
                    statusGroup.querySelectorAll('.pm-chip').forEach(c => c.classList.remove('active'));
                    btn.classList.add('active');
                    state.status = btn.dataset.status;
                    this._saveListState();
                    this._renderFilteredList(container, typeFilter);
                });
            });
        }

        const viewGroup = container.querySelector(`#pm-view-${suffix}`);
        if (viewGroup) {
            const glyphs = { grid: 'layout-grid', list: 'list' };
            viewGroup.querySelectorAll('.pm-seg').forEach(seg => {
                seg.classList.toggle('active', seg.dataset.view === state.view);
                try { seg.appendChild(this.ui.createIcon(glyphs[seg.dataset.view])); } catch (e) { }
                seg.addEventListener('click', (e) => {
                    const btn = e.currentTarget;
                    viewGroup.querySelectorAll('.pm-seg').forEach(c => c.classList.remove('active'));
                    btn.classList.add('active');
                    state.view = btn.dataset.view;
                    this._saveListState();
                    this._renderFilteredList(container, typeFilter);
                });
            });
        }
        // The color-filter row is rebuilt (with its own listeners) by _renderColorFilter().
    }

    _saveListState() {
        try {
            // Search text is intentionally not persisted.
            const out = {};
            for (const tab of ['app', 'collection']) {
                const s = this._listState[tab];
                out[tab] = { sort: s.sort, status: s.status, color: s.color, view: s.view };
            }
            localStorage.setItem('pm_list_state', JSON.stringify(out));
        } catch (e) { }
    }

    // Normalized descriptor for a live plugin — the shape we filter and sort on.
    _liveDescriptor(p, panelContainer) {
        let conf;
        try {
            conf = p.getExistingCodeAndConfig().json;
        } catch (e) {
            conf = { name: 'Unknown', version: 'Unknown' };
        }
        const attr = this._pluginAttribution(conf);
        return {
            kind: 'live',
            plugin: p,
            conf,
            name: conf.name || 'Unnamed Plugin',
            description: conf.description || '',
            version: conf.version || conf.ver || '',
            sourceRepo: conf.__source_repo || '',
            author: attr ? attr.label : '',
            colorHex: this._pluginColors[this._pluginColorKey(conf, p.getGuid())] || null,
            enabled: true
        };
    }

    // Normalized descriptor for a disabled ("ghost") entry. Older entries predate the
    // description/author fields, so fall back to the stashed json / the repo owner.
    _ghostDescriptor(d) {
        const author = this._pluginAttribution({
            author: d.author || (d.json && d.json.author),
            __source_repo: d.sourceRepo || ''
        });
        return {
            kind: 'ghost',
            disabled: d,
            name: d.name || 'Unnamed Plugin',
            description: d.description || (d.json && d.json.description) || '',
            version: d.version || '',
            sourceRepo: d.sourceRepo || '',
            author: author ? author.label : '',
            colorHex: this._ghostColorHex(d),
            enabled: false
        };
    }

    // Build (and cache) the descriptor list for one tab.
    _buildListCache(typeFilter, plugins, panelContainer) {
        const live = plugins.map(p => this._liveDescriptor(p, panelContainer));
        const ghosts = this._getDisabledPluginsForType(typeFilter).map(d => this._ghostDescriptor(d));
        this._listCache[typeFilter] = live.concat(ghosts);
        return this._listCache[typeFilter];
    }

    _colorRank(hex) {
        if (!hex) return PM_CARD_COLORS.length; // uncolored sorts last
        const i = PM_CARD_COLORS.findIndex(c => c.hex.toLowerCase() === String(hex).toLowerCase());
        return i === -1 ? PM_CARD_COLORS.length : i;
    }

    _applyListFilters(items, state) {
        const q = (state.q || '').trim().toLowerCase();
        return items.filter(it => {
            if (state.status === 'active' && !it.enabled) return false;
            if (state.status === 'inactive' && it.enabled) return false;
            if (state.color && String(it.colorHex || '').toLowerCase() !== state.color.toLowerCase()) return false;
            if (!q) return true;
            const hay = `${it.name} ${it.description} ${it.author} ${it.version} ${it.sourceRepo}`.toLowerCase();
            return hay.includes(q);
        });
    }

    _sortListItems(items, sort) {
        const byName = (a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
        const sorted = items.slice();
        sorted.sort((a, b) => {
            if (sort === 'author') {
                // Empty authors sort last.
                if (!a.author && b.author) return 1;
                if (a.author && !b.author) return -1;
                const c = a.author.localeCompare(b.author, undefined, { sensitivity: 'base' });
                if (c !== 0) return c;
            } else if (sort === 'color') {
                const c = this._colorRank(a.colorHex) - this._colorRank(b.colorHex);
                if (c !== 0) return c;
            } else if (sort === 'status') {
                if (a.enabled !== b.enabled) return a.enabled ? -1 : 1;
            }
            return byName(a, b);
        });
        return sorted;
    }

    // Render the color-filter swatches for a tab — only the colors actually in use.
    _renderColorFilter(panelContainer, typeFilter) {
        const row = panelContainer.querySelector(typeFilter === 'app' ? '#pm-colorfilter-global' : '#pm-colorfilter-col');
        if (!row) return;
        const state = this._listState[typeFilter];
        const items = this._listCache[typeFilter] || [];

        const inUse = PM_CARD_COLORS.filter(c =>
            items.some(it => String(it.colorHex || '').toLowerCase() === c.hex.toLowerCase())
        );

        row.innerHTML = '';
        if (inUse.length === 0) {
            row.classList.add('pm-hidden');
            if (state.color) { state.color = null; this._saveListState(); }
            return;
        }
        row.classList.remove('pm-hidden');

        // A single "Color" button that opens the swatch popover — no swatch row in the toolbar.
        const active = state.color
            ? PM_CARD_COLORS.find(c => c.hex.toLowerCase() === state.color.toLowerCase())
            : null;

        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'pm-btn pm-colorfilter-btn';
        btn.title = active ? `Filtering by ${active.name} — click to change` : 'Filter by color';

        const dot = document.createElement('span');
        dot.className = 'pm-colorfilter-dot';
        if (active) dot.style.background = active.hex;
        else dot.dataset.any = '';
        btn.appendChild(dot);
        btn.appendChild(document.createTextNode(active ? active.name : 'Color'));

        btn.addEventListener('click', () => {
            if (this._colorPopover) { this._closeColorPopover(); return; }
            // Only offer colors actually in use; the popover's "None" swatch clears the filter.
            this._openColorPopover(btn, state.color, (hex) => {
                state.color = hex || null;
                this._saveListState();
                this._renderFilteredList(panelContainer, typeFilter);
            }, inUse);
        });

        row.appendChild(btn);
    }

    // Filter + sort the cached descriptors and (re)paint one tab's list.
    // Called on every search keystroke / sort / filter change — no SDK re-fetch.
    _renderFilteredList(panelContainer, typeFilter) {
        const containerId = typeFilter === 'app' ? 'pm-global-list' : 'pm-collections-list';
        const container = panelContainer.querySelector(`#${containerId}`);
        if (!container) return;

        const state = this._listState[typeFilter];
        const all = this._listCache[typeFilter] || [];
        const availableUpdates = this._readUpdateCache();

        this._renderColorFilter(panelContainer, typeFilter);

        const visible = this._sortListItems(this._applyListFilters(all, state), state.sort);

        // Compact full-width rows vs the default card grid.
        container.classList.toggle('pm-view-list', state.view === 'list');

        container.innerHTML = '';

        if (visible.length === 0) {
            const empty = document.createElement('div');
            empty.className = 'pm-empty-state';
            const filtering = !!(state.q || state.color || state.status !== 'all');
            empty.textContent = all.length === 0
                ? 'No items found.'
                : (filtering ? 'No plugins match your search or filters.' : 'No items found.');
            container.appendChild(empty);
            return;
        }

        visible.forEach(it => {
            const card = it.kind === 'live'
                ? this._renderLiveCard(it.plugin, it.conf, panelContainer, availableUpdates, typeFilter)
                : this._renderGhostCard(it.disabled, panelContainer, typeFilter);
            container.appendChild(card);
        });
    }

    // Show/hide a tab's "Update All" button based on the FULL (unfiltered) set.
    _refreshUpdateAllVisibility(panelContainer, typeFilter) {
        try {
            const availableUpdates = this._readUpdateCache();
            const items = this._listCache[typeFilter] || [];
            const hasUpdates = items.some(it =>
                it.kind === 'live' && availableUpdates[it.plugin.getGuid()]
            );
            const btnId = typeFilter === 'app' ? '#pm-update-all-global-btn' : '#pm-update-all-col-btn';
            const btn = panelContainer.querySelector(btnId);
            // Toggle the class, not inline display: `.pm-hidden` is `display: none !important`,
            // which an inline style cannot override (this was the fix in PR #2).
            if (btn) btn.classList.toggle('pm-hidden', !hasUpdates);
        } catch (e) { }
    }


    // --- Theme Library ---

    async _saveThemes() {
        await this._saveManagerSettings({ savedThemes: this._savedThemes });
    }

    _renderThemesList(container) {
        const list = container.querySelector('#pm-themes-list');
        if (!list) return;

        if (this._savedThemes.length === 0) {
            list.innerHTML = `
                <div class="pm-card pm-empty-state">
                    <div class="pm-card-info">
                        <p>No themes saved yet. Use <strong>Add from GitHub</strong> to fetch a theme CSS from a repository, or <strong>Paste CSS</strong> to save your own theme.</p>
                        <p class="pm-meta-text">Once saved, use <strong>Backup Theme CSS</strong> to copy the combined CSS into Thymer's <strong>Edit Theme CSS</strong> setting.</p>
                    </div>
                </div>`;
            return;
        }

        list.innerHTML = '';
        this._savedThemes.forEach((theme, idx) => {
            const card = document.createElement('div');
            card.className = 'pm-card';
            card.innerHTML = `
                <div class="pm-card-info">
                    <h3>${this._escHtml(theme.name)}
                        <span class="pm-badge pm-version-badge">${theme.source ? 'GitHub' : 'Manual'}</span>
                    </h3>
                    <p class="pm-meta-text">
                        ${theme.css.length} chars · Added ${new Date(theme.date).toLocaleDateString()}
                        ${theme.source ? ` · <span class="pm-card-url" data-external-url="${this._escHtml(theme.source)}">${this._escHtml(theme.source)}</span>` : ''}
                    </p>
                </div>
                <div class="pm-card-actions"></div>
            `;

            const actions = card.querySelector('.pm-card-actions');

            // Copy CSS button
            const copyBtn = document.createElement('button');
            copyBtn.className = 'pm-btn';
            copyBtn.title = 'Copy this theme CSS to clipboard';
            copyBtn.appendChild(this.ui.createIcon('copy'));
            actions.appendChild(copyBtn);
            copyBtn.addEventListener('click', async () => {
                await navigator.clipboard.writeText(theme.css);
                this.ui.addToaster({ title: 'Copied!', message: `${theme.name} CSS copied to clipboard.`, autoDestroyTime: 3000, dismissible: true });
            });

            // Edit button
            const editBtn = document.createElement('button');
            editBtn.className = 'pm-btn';
            editBtn.title = 'Edit theme';
            editBtn.appendChild(this.ui.createIcon('edit'));
            actions.appendChild(editBtn);
            editBtn.addEventListener('click', () => {
                this._showEditThemeDialog(container, idx);
            });

            // Delete button
            const delBtn = document.createElement('button');
            delBtn.className = 'pm-btn danger pm-btn-delete';
            delBtn.title = 'Remove theme';
            delBtn.appendChild(this.ui.createIcon('x'));
            actions.appendChild(delBtn);
            delBtn.addEventListener('click', async () => {
                if (await this._showConfirmModal('Remove theme', `Remove theme "${theme.name}"?`, { confirmText: 'Remove', danger: true })) {
                    this._savedThemes.splice(idx, 1);
                    this._saveThemes();
                    this._autoExport();
                    this._renderThemesList(container);
                    this._renderWorkspaceSummary(container);
                }
            });

            list.appendChild(card);
        });
    }

    async _addThemeFromGithub(container) {
        const url = await this._showPromptModal('Add Theme from GitHub', 'Enter the GitHub repo URL for the theme:');
        if (!url) return;

        this.ui.addToaster({ title: 'Fetching theme CSS...', autoDestroyTime: 2000, dismissible: true });

        try {
            const cssText = this._sanitizeCSS(await this._fetchThemeCSS(url));
            const { owner, repo } = this._parseGithubUrl(url);
            const name = await this._showPromptModal('Name This Theme', 'Enter a name for this theme:', repo || 'My Theme');
            if (!name) return;

            this._savedThemes.push({
                id: Date.now().toString(36),
                name,
                css: cssText,
                source: url,
                date: new Date().toISOString()
            });
            this._saveThemes();
            this._autoExport();
            this._renderThemesList(container);
            this._renderWorkspaceSummary(container);
            this.ui.addToaster({ title: 'Theme Saved', message: `"${name}" added to your Theme Library.`, autoDestroyTime: 3000, dismissible: true });
        } catch (fetchErr) {
            // CSS not auto-detected → fall back to manual paste modal
            this._showManualThemePasteDialog(container, url, fetchErr.message);
        }
    }

    _addThemeManually(container) {
        this._showManualThemePasteDialog(container, null, null);
    }

    _showManualThemePasteDialog(container, sourceUrl, errorMsg) {
        let defaultName = 'My Theme';
        let repoLinkHtml = '';
        if (sourceUrl) {
            try {
                const { repo } = this._parseGithubUrl(sourceUrl);
                if (repo) defaultName = repo;
                repoLinkHtml = `<p class="pm-modal-link-row">
                                    <span class="pm-card-url" data-external-url="${this._escHtml(sourceUrl)}">
                                        Open repository in new tab
                                    </span>
                                </p>`;
            } catch (e) { /* ignore parse error */ }
        }

        const overlayHtml = `
            <div class="pm-modal">
                <div class="pm-modal-content">
                    <h3>Edit Theme</h3>
                    ${repoLinkHtml}
                    <div class="pm-input-group" style="margin-bottom: 10px;">
                        <label>Theme Name</label>
                        <input type="text" id="pm-manual-theme-name" class="pm-input" value="${this._escHtml(defaultName)}" placeholder="My Theme" />
                    </div>
                    <textarea id="pm-manual-theme-css" class="pm-textarea" placeholder="Paste your theme CSS here..."></textarea>
                    <div style="margin-top: 15px; display: flex; justify-content: flex-end; gap: 10px;">
                        <button class="pm-btn" id="pm-manual-theme-cancel">Cancel</button>
                        <button class="pm-btn primary" id="pm-manual-theme-save">Save Theme</button>
                    </div>
                </div>
            </div>
        `;

        const tempDiv = document.createElement('div');
        tempDiv.innerHTML = overlayHtml;
        this._openModal(tempDiv);

        tempDiv.querySelector('#pm-manual-theme-cancel').addEventListener('click', () => this._closeModal(tempDiv));
        tempDiv.querySelector('#pm-manual-theme-save').addEventListener('click', () => {
            const name = tempDiv.querySelector('#pm-manual-theme-name').value.trim();
            const css = tempDiv.querySelector('#pm-manual-theme-css').value.trim();
            if (!name || !css) {
                this.ui.addToaster({ title: 'Missing Fields', message: 'Please provide both a name and CSS.', autoDestroyTime: 3000, dismissible: true });
                return;
            }
            this._savedThemes.push({
                id: Date.now().toString(36),
                name,
                css,
                source: sourceUrl || '',
                date: new Date().toISOString()
            });
            this._saveThemes();
            this._autoExport();
            this._closeModal(tempDiv);
            this._renderThemesList(container);
            this._renderWorkspaceSummary(container);
            this.ui.addToaster({ title: 'Theme Saved', message: `"${name}" added to your Theme Library.`, autoDestroyTime: 3000, dismissible: true });
        });
    }

    _showEditThemeDialog(container, idx) {
        const theme = this._savedThemes[idx];
        if (!theme) return;

        const sourceUrl = theme.source || '';
        let repoLinkHtml = '';
        if (sourceUrl) {
            repoLinkHtml = `<p class="pm-modal-link-row">
                                <span class="pm-card-url" data-external-url="${this._escHtml(sourceUrl)}">
                                    Open repository in new tab
                                </span>
                            </p>`;
        }

        const overlayHtml = `
            <div class="pm-modal">
                <div class="pm-modal-content">
                    <h3>Edit Theme</h3>
                    ${repoLinkHtml}
                    <div class="pm-input-group" style="margin-bottom: 10px;">
                        <label>Theme Name</label>
                        <input type="text" id="pm-edit-theme-name" class="pm-input" value="${this._escHtml(theme.name)}" placeholder="My Theme" />
                    </div>
                    <textarea id="pm-edit-theme-css" class="pm-textarea" placeholder="Paste your theme CSS here...">${this._escHtml(theme.css)}</textarea>
                    <div style="margin-top: 15px; display: flex; justify-content: flex-end; gap: 10px;">
                        <button class="pm-btn" id="pm-edit-theme-cancel">Cancel</button>
                        <button class="pm-btn primary" id="pm-edit-theme-save">Save Changes</button>
                    </div>
                </div>
            </div>
        `;

        const tempDiv = document.createElement('div');
        tempDiv.innerHTML = overlayHtml;
        this._openModal(tempDiv);

        tempDiv.querySelector('#pm-edit-theme-cancel').addEventListener('click', () => this._closeModal(tempDiv));
        tempDiv.querySelector('#pm-edit-theme-save').addEventListener('click', () => {
            const name = tempDiv.querySelector('#pm-edit-theme-name').value.trim();
            const css = tempDiv.querySelector('#pm-edit-theme-css').value.trim();
            if (!name || !css) {
                this.ui.addToaster({ title: 'Missing Fields', message: 'Please provide both a name and CSS.', autoDestroyTime: 3000, dismissible: true });
                return;
            }
            this._savedThemes[idx] = {
                ...this._savedThemes[idx],
                name,
                css,
                date: new Date().toISOString()
            };
            this._saveThemes();
            this._autoExport();
            this._closeModal(tempDiv);
            this._renderThemesList(container);
            this._renderWorkspaceSummary(container);
            this.ui.addToaster({ title: 'Theme Updated', message: `"${name}" has been updated.`, autoDestroyTime: 3000, dismissible: true });
        });
    }

    /** Register a modal overlay so it gets cleaned up in onUnload if still open. */
    _openModal(el) {
        if (!this._activeModals) this._activeModals = [];
        this._activeModals.push(el);
        el.classList.add('pm-tokens');
        document.body.appendChild(el);

        // Close modal when clicking outside its content area (on the background overlay)
        el.addEventListener('click', (e) => {
            // Handle external link clicks inside modals
            const linkEl = e.target.closest('[data-external-url]');
            if (linkEl) {
                e.preventDefault();
                this._openExternalLink(linkEl.dataset.externalUrl);
                return;
            }
            if (e.target.classList.contains('pm-modal')) {
                this._closeModal(el);
            }
        });

        return el;
    }

    /** Remove a modal and deregister it from the active list. */
    _closeModal(el) {
        if (el && el.parentNode) el.parentNode.removeChild(el);
        if (this._activeModals) {
            const idx = this._activeModals.indexOf(el);
            if (idx !== -1) this._activeModals.splice(idx, 1);
        }
    }

    /**
     * Custom prompt modal that replaces native prompt() which is blocked in
     * embedded/WebView/Electron environments.
     * @param {string} title - Dialog title
     * @param {string} message - Descriptive text shown above the input
     * @param {string} [defaultValue=''] - Pre-filled value for the input
     * @returns {Promise<string|null>} The user's input, or null if cancelled
     */
    // Confirmation popover — replaces the browser's native confirm() AND a centred modal.
    // It pops up right where the user clicked (on the card / button itself) rather than
    // yanking focus to the middle of the screen. Resolves true/false; also serves as a
    // two-way chooser via custom button labels.
    _showConfirmModal(title, message, opts = {}) {
        const confirmText = opts.confirmText || 'Confirm';
        const cancelText = opts.cancelText || 'Cancel';
        const danger = !!opts.danger;

        return new Promise(resolve => {
            const body = String(message || '')
                .split('\n')
                .filter(line => line.trim() !== '')
                .map(line => `<p class="pm-confirm-line">${this._escHtml(line)}</p>`)
                .join('');

            // Transparent scrim catches outside clicks without dimming the whole panel.
            const scrim = document.createElement('div');
            scrim.className = 'pm-confirm-scrim';
            scrim.innerHTML = `
                <div class="pm-tokens pm-confirm-pop" role="dialog" aria-modal="true">
                    <h3>${this._escHtml(title)}</h3>
                    <div class="pm-confirm-body">${body}</div>
                    <div class="pm-confirm-actions">
                        <button class="pm-btn" data-confirm-cancel>${this._escHtml(cancelText)}</button>
                        <button class="pm-btn ${danger ? 'danger' : 'primary'}" data-confirm-ok>${this._escHtml(confirmText)}</button>
                    </div>
                </div>
            `;
            document.body.appendChild(scrim);
            this._activeModals = this._activeModals || [];
            this._activeModals.push(scrim);

            const pop = scrim.querySelector('.pm-confirm-pop');

            // Anchor to the clicked element if given, else to the last pointer position.
            const rect = opts.anchor && opts.anchor.isConnected ? opts.anchor.getBoundingClientRect() : null;
            const px = rect ? rect.left + rect.width / 2 : (this._lastPointer ? this._lastPointer.x : window.innerWidth / 2);
            const py = rect ? rect.bottom : (this._lastPointer ? this._lastPointer.y : window.innerHeight / 2);

            const pr = pop.getBoundingClientRect();
            const M = 12;
            let left = px - pr.width / 2;
            let top = py + 10;
            if (top + pr.height > window.innerHeight - M) top = Math.max(M, py - pr.height - 14); // flip above
            left = Math.min(Math.max(M, left), window.innerWidth - pr.width - M);
            pop.style.left = `${left}px`;
            pop.style.top = `${Math.max(M, top)}px`;

            const okBtn = pop.querySelector('[data-confirm-ok]');
            const cancelBtn = pop.querySelector('[data-confirm-cancel]');
            setTimeout(() => okBtn.focus(), 30);

            let settled = false;
            const close = (value) => {
                if (settled) return;
                settled = true;
                document.removeEventListener('keydown', onKey, true);
                if (scrim.parentNode) scrim.parentNode.removeChild(scrim);
                this._activeModals = (this._activeModals || []).filter(m => m !== scrim);
                resolve(value);
            };
            const onKey = (e) => {
                if (e.key === 'Escape') { e.stopPropagation(); close(false); }
                else if (e.key === 'Enter') { e.stopPropagation(); close(true); }
            };
            document.addEventListener('keydown', onKey, true);

            okBtn.addEventListener('click', () => close(true));
            cancelBtn.addEventListener('click', () => close(false));
            scrim.addEventListener('mousedown', (e) => {
                if (e.target === scrim) close(false); // clicking outside cancels
            });
        });
    }

    _showPromptModal(title, message, defaultValue = '') {
        return new Promise(resolve => {
            const overlayHtml = `
                <div class="pm-modal">
                    <div class="pm-modal-content">
                        <h3>${this._escHtml(title)}</h3>
                        <p style="font-size: 13px; color: var(--pm-text-muted); margin-bottom: 10px;">${this._escHtml(message)}</p>
                        <input type="text" id="pm-prompt-input" class="pm-input" value="${this._escHtml(defaultValue)}" placeholder="" autocomplete="off" />
                        <div style="margin-top: 15px; display: flex; justify-content: flex-end; gap: 10px;">
                            <button class="pm-btn" id="pm-prompt-cancel">Cancel</button>
                            <button class="pm-btn primary" id="pm-prompt-ok">OK</button>
                        </div>
                    </div>
                </div>
            `;

            const tempDiv = document.createElement('div');
            tempDiv.innerHTML = overlayHtml;
            this._openModal(tempDiv);

            const input = tempDiv.querySelector('#pm-prompt-input');
            setTimeout(() => { input.focus(); input.select(); }, 50);

            const close = (value) => {
                this._closeModal(tempDiv);
                resolve(value);
            };

            tempDiv.querySelector('#pm-prompt-cancel').addEventListener('click', () => close(null));
            tempDiv.querySelector('#pm-prompt-ok').addEventListener('click', () => close(input.value.trim()));
            input.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') close(input.value.trim());
                if (e.key === 'Escape') close(null);
            });
        });
    }

    /** Open an external URL in a new browser tab/window. */
    _openExternalLink(url) {
        if (url) window.open(url, '_blank', 'noopener,noreferrer');
    }

    async _exportAllThemes() {
        if (this._savedThemes.length === 0) {
            this.ui.addToaster({ title: 'No Themes', message: 'No themes saved to export.', autoDestroyTime: 3000, dismissible: true });
            return;
        }
        const combined = this._savedThemes.map(t => `/* === ${t.name} === */\n${t.css}`).join('\n\n');

        const overlayHtml = `
            <div class="pm-modal">
                <div class="pm-modal-content pm-export-content">
                    <h3>Export All Themes</h3>
                    <p style="font-size: 13px; color: var(--pm-text-muted); margin-bottom: 10px;">Copy this combined CSS and paste it into Thymer's <strong>Edit Theme CSS</strong> setting.</p>
                    <textarea class="pm-textarea pm-textarea-json" id="pm-all-themes-css" readonly></textarea>
                    <div style="margin-top: 15px; display: flex; justify-content: flex-end; gap: 10px;">
                        <button class="pm-btn" id="pm-themes-export-copy">Copy to Clipboard</button>
                        <button class="pm-btn" id="pm-themes-export-download">Download .css</button>
                        <button class="pm-btn primary" id="pm-themes-export-close">Close</button>
                    </div>
                </div>
            </div>
        `;

        const tempDiv = document.createElement('div');
        tempDiv.innerHTML = overlayHtml;
        this._openModal(tempDiv);
        tempDiv.querySelector('#pm-all-themes-css').value = combined;

        tempDiv.querySelector('#pm-themes-export-close').addEventListener('click', () => this._closeModal(tempDiv));

        tempDiv.querySelector('#pm-themes-export-copy').addEventListener('click', async (e) => {
            await navigator.clipboard.writeText(combined);
            const orig = e.target.innerText;
            e.target.innerText = 'Copied!';
            setTimeout(() => e.target.innerText = orig, 2000);
        });

        tempDiv.querySelector('#pm-themes-export-download').addEventListener('click', () => {
            const blob = new Blob([combined], { type: 'text/css' });
            const blobUrl = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = blobUrl;
            const wsName = this._getWorkspaceName();
            const ts = this._getBackupTimestamp();
            a.download = `thymer-backup-themes-${wsName}-${ts}.css`;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(blobUrl);
        });
    }


    async previewTheme(repoUrl) {
        try {
            const { owner, repo } = this._parseGithubUrl(repoUrl);
            if (!owner || !repo) return;

            // Fetch README directly from raw.githubusercontent.com to avoid CORS
            let content = '';
            for (const branch of ['main', 'master']) {
                try {
                    const readmeRes = await fetch(`https://raw.githubusercontent.com/${owner}/${repo}/${branch}/README.md`);
                    if (readmeRes.ok) {
                        content = await readmeRes.text();
                        break;
                    }
                } catch (e) { /* try next branch */ }
            }

            if (!content) throw new Error("No README found");

            // Extract images from markdown
            const imgRegex = /!\[.*?\]\((.*?)\)|<img.*?src="(.*?)".*?>/g;
            const images = [];
            let imgMatch;
            while ((imgMatch = imgRegex.exec(content)) !== null) {
                const src = imgMatch[1] || imgMatch[2];
                if (src && src.startsWith('http')) {
                    images.push(src);
                }
            }

            if (images.length === 0) {
                this.ui.addToaster({ title: "No Previews", message: "No images found in the theme's README.", autoDestroyTime: 3000, dismissible: true });
                return;
            }

            const overlayHtml = `
                <div id="pm-theme-preview-modal" class="pm-modal">
                    <div class="pm-modal-content" style="width: 800px; max-height: 90vh; overflow-y: auto;">
                        <h3>Theme Preview</h3>
                        <div style="display: flex; flex-direction: column; gap: 15px; margin-top: 15px;">
                            ${images.filter(img => img.startsWith('https://')).map(img => `<img src="${this._escHtml(img)}" style="max-width: 100%; border-radius: 4px; border: 1px solid var(--pm-border-default);" />`).join('')}
                        </div>
                        <div style="margin-top: 20px; display: flex; justify-content: flex-end;">
                            <button class="pm-btn primary" id="pm-close-preview">Close</button>
                        </div>
                    </div>
                </div>
            `;

            const tempDiv = document.createElement('div');
            tempDiv.innerHTML = overlayHtml;
            this._openModal(tempDiv);

            document.getElementById('pm-close-preview').addEventListener('click', () => {
                this._closeModal(tempDiv);
            });

        } catch (e) {
            this.ui.addToaster({ title: "Preview Failed", message: "Could not load theme preview images.", autoDestroyTime: 3000, dismissible: true });
        }
    }

    /**
     * Fetch theme CSS using smart file discovery.
     */
    async _fetchThemeCSS(repoUrl) {
        const { owner, repo, subpath } = this._parseGithubUrl(repoUrl);
        if (!owner || !repo) throw new Error("Invalid GitHub URL.");

        const prefix = subpath ? `${subpath}/` : '';
        const cssFilenames = ['plugin.css', 'styles.css', 'theme.css', 'style.css', `${repo}-plugin.css`, 'Custom CSS'];

        // Strategy 1: Try common CSS filenames via raw.githubusercontent.com
        for (const branch of ['main', 'master']) {
            for (const filename of cssFilenames) {
                const url = `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${prefix}${filename}`;
                try {
                    const res = await fetch(url);
                    if (res.ok) return await res.text();
                } catch (e) { /* try next */ }
            }
        }

        // Strategy 2: Use GitHub API to list directory and find CSS-like files
        try {
            const files = await this._listRepoDirectory(owner, repo, subpath);
            // First try the smart role-based finder (includes extensionless name matching)
            const cssFile = this._findFileByRole(files, 'css');
            if (cssFile) {
                const res = await fetch(cssFile.download_url);
                if (res.ok) return await res.text();
            }
            // Fallback: if there's exactly one .css file in the repo, use it regardless of name
            const allCssFiles = files.filter(f => f.name && f.name.endsWith('.css'));
            if (allCssFiles.length === 1 && allCssFiles[0].download_url) {
                const res = await fetch(allCssFiles[0].download_url);
                if (res.ok) return await res.text();
            }

            // Strategy 3: Content-sniff extensionless files with "css" in the name
            // (reuses the same directory listing to avoid a second API call)
            const candidates = files.filter(f =>
                f.type === 'file' && !f.name.includes('.') && f.name.toLowerCase().includes('css')
            );
            for (const candidate of candidates) {
                if (!candidate.download_url) continue;
                const res = await fetch(candidate.download_url);
                if (!res.ok) continue;
                const text = await res.text();
                if (this._looksLikeCSS(text)) return text;
            }
        } catch (e) { /* fall through */ }

        throw new Error("No CSS file found in this repository. You can paste the CSS manually instead.");
    }

    // --- Auto-Export ---

    _getBackupConfigSnapshot(baseJson, liveConfig) {
        const baseSnapshot = this._cloneJsonValue(baseJson || {});
        if (!liveConfig || typeof liveConfig !== 'object') return baseSnapshot;

        const liveSnapshot = this._cloneJsonValue(liveConfig);
        const reservedKeys = ['name', 'type', 'description', 'version', 'icon', 'permissions', '__source_repo', '__source_files', 'ver'];
        for (const key of reservedKeys) {
            if (baseSnapshot[key] !== undefined && liveSnapshot[key] === undefined) {
                liveSnapshot[key] = baseSnapshot[key];
            }
        }

        if (baseSnapshot.__source_repo !== undefined) liveSnapshot.__source_repo = baseSnapshot.__source_repo;
        if (baseSnapshot.__source_files !== undefined) liveSnapshot.__source_files = baseSnapshot.__source_files;
        return liveSnapshot;
    }

    /** Get a reusable export data array for all plugins + collections */
    async _getExportData() {
        const allGlobals = await this.data.getAllGlobalPlugins();
        const allCollections = await this.data.getAllCollections();

        const globalsData = allGlobals.map(p => {
            try {
                const { json, code, css } = p.getExistingCodeAndConfig();
                const liveConfig = typeof p.getConfiguration === 'function' ? p.getConfiguration() : null;
                const mergedJson = this._getBackupConfigSnapshot(json, liveConfig);
                return { name: mergedJson.name, type: 'plugin', version: mergedJson.version, source_repo: mergedJson.__source_repo, code, css, json: mergedJson };
            } catch (e) { return null; }
        });

        // Build a guid->name map for all collections (for filter_colguid annotation)
        const colGuidToName = {};
        for (const p of allCollections) {
            try {
                const lc = p.getConfiguration();
                const guid = p.getGuid ? p.getGuid() : null;
                if (guid && lc && lc.name) colGuidToName[guid] = lc.name;
            } catch (e) { }
        }

        const collectionsData = allCollections.map(p => {
            try {
                const { json, code, css } = p.getExistingCodeAndConfig();

                // Use the live configuration so runtime edits and newer schema keys are preserved in backups.
                let mergedJson = this._getBackupConfigSnapshot(json, null);
                try {
                    const liveConfig = p.getConfiguration();
                    if (liveConfig) {
                        mergedJson = this._getBackupConfigSnapshot(json, liveConfig);
                    }
                } catch (configErr) {
                    console.warn(`[Plugins Manager] Failed to get live config for collection ${json.name}:`, configErr);
                }

                // Annotate link-to-record fields with the target collection name
                // so the GUID can be remapped when importing into a different workspace
                if (Array.isArray(mergedJson.fields)) {
                    mergedJson.fields = mergedJson.fields.map(f => {
                        if (f.filter_colguid && colGuidToName[f.filter_colguid]) {
                            return { ...f, filter_colname: colGuidToName[f.filter_colguid] };
                        }
                        return f;
                    });
                }

                return { name: mergedJson.name, type: 'collection', version: mergedJson.version, source_repo: mergedJson.__source_repo, code, css, json: mergedJson };
            } catch (e) { return null; }
        });

        const sorted = this._topoSortCollections(collectionsData.filter(Boolean), colGuidToName);
        return [...globalsData, ...sorted];
    }

    _getManagerExportData() {
        return {
            communityRepos: this.communityRepos || '',
            savedThemes: this._cloneJsonValue(Array.isArray(this._savedThemes) ? this._savedThemes : []),
            autoExportEnabled: !!this._autoExportEnabled,
            autoExportDirName: this._autoExportDirName || ''
        };
    }

    _buildExportPayload(typeFilter, items) {
        const payload = {
            schemaVersion: 2,
            exportedAt: new Date().toISOString(),
            section: typeFilter,
            items
        };
        if (typeFilter === 'app' || typeFilter === 'all') {
            payload.managerSettings = this._getManagerExportData();
        }
        return payload;
    }

    _normalizeImportedBackup(parsed, typeFilter) {
        if (Array.isArray(parsed)) {
            return { items: parsed, managerSettings: null };
        }
        if (!parsed || typeof parsed !== 'object') {
            throw new Error('Invalid backup format');
        }
        const items = Array.isArray(parsed.items)
            ? parsed.items
            : (Array.isArray(parsed.plugins) ? parsed.plugins : null);
        if (!items) {
            throw new Error('Backup does not contain any items');
        }
        return {
            items,
            managerSettings: (typeFilter === 'app' || typeFilter === 'all') ? (parsed.managerSettings || null) : null
        };
    }

    async _restoreImportedManagerSettings(managerSettings, container) {
        if (!managerSettings || typeof managerSettings !== 'object') return;
        await this._saveManagerSettings({
            communityRepos: typeof managerSettings.communityRepos === 'string' ? managerSettings.communityRepos : undefined,
            savedThemes: Array.isArray(managerSettings.savedThemes) ? managerSettings.savedThemes : undefined,
            autoExportEnabled: typeof managerSettings.autoExportEnabled === 'boolean' ? managerSettings.autoExportEnabled : undefined
        });

        if (typeof managerSettings.autoExportDirName === 'string') {
            this._autoExportDirName = managerSettings.autoExportDirName;
            localStorage.setItem('pm_auto_export_dir_name', managerSettings.autoExportDirName);
        }

        if (container) {
            const reposInput = container.querySelector('#pm-repos-input');
            if (reposInput) reposInput.value = this.communityRepos;
            const autoExportToggle = container.querySelector('#pm-auto-export-toggle');
            if (autoExportToggle) autoExportToggle.checked = this._autoExportEnabled;
            const autoExportDirLabel = container.querySelector('#pm-auto-export-dir-label');
            if (autoExportDirLabel) autoExportDirLabel.textContent = this._autoExportDirName ? '📁 ' + this._autoExportDirName : 'No directory selected';
            this._renderThemesList(container);
            this._renderWorkspaceSummary(container);
        }
    }

    /**
     * Topologically sort collection export items so that collections depended upon
     * (via link-to-record filter_colguid) appear before the collections that reference them.
     * Falls back to original order for any cycles or unresolvable references.
     */
    _topoSortCollections(items, colGuidToName) {
        // Build name->item index
        const byName = {};
        for (const item of items) {
            if (item && item.name) byName[item.name] = item;
        }

        // Build adjacency: for each collection, which collection names does it depend on?
        const deps = {};
        for (const item of items) {
            deps[item.name] = new Set();
            const fields = item.json && item.json.fields;
            if (Array.isArray(fields)) {
                for (const f of fields) {
                    const depName = f.filter_colname || (f.filter_colguid && colGuidToName[f.filter_colguid]);
                    if (depName && depName !== item.name && byName[depName]) {
                        deps[item.name].add(depName);
                    }
                }
            }
        }

        // Kahn's algorithm (BFS topological sort)
        const inDegree = {};
        const dependents = {}; // dep -> [items that depend on it]
        for (const item of items) {
            inDegree[item.name] = inDegree[item.name] || 0;
            dependents[item.name] = dependents[item.name] || [];
        }
        for (const item of items) {
            for (const dep of deps[item.name]) {
                inDegree[item.name] = (inDegree[item.name] || 0) + 1;
                dependents[dep] = dependents[dep] || [];
                dependents[dep].push(item.name);
            }
        }

        const queue = items.filter(item => (inDegree[item.name] || 0) === 0).map(i => i.name);
        const result = [];
        const visited = new Set();

        while (queue.length > 0) {
            const name = queue.shift();
            if (visited.has(name)) continue;
            visited.add(name);
            if (byName[name]) result.push(byName[name]);
            for (const dependent of (dependents[name] || [])) {
                inDegree[dependent] = (inDegree[dependent] || 1) - 1;
                if (inDegree[dependent] === 0) queue.push(dependent);
            }
        }

        // Append any remaining items not reached (cycles or isolated)
        for (const item of items) {
            if (!visited.has(item.name)) result.push(item);
        }

        return result;
    }

    _getWorkspaceName() {
        try {
            if (window.location && window.location.hostname) {
                const parts = window.location.hostname.split('.');
                if (parts.length > 0 && parts[0] !== 'localhost' && parts[0] !== '127') {
                    return parts[0];
                }
            }
        } catch (e) { }
        return 'workspace';
    }

    _getBackupTimestamp() {
        const now = new Date();
        const pad = (n) => String(n).padStart(2, '0');
        return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}T${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
    }

    _getBackupJsonFilename(section) {
        const wsName = this._getWorkspaceName();
        const ts = this._getBackupTimestamp();
        if (section === 'all') {
            return `thymer-backup-workspace-${wsName}-${ts}.json`;
        }
        if (section === 'collection') {
            return `thymer-backup-collections-${wsName}-${ts}.json`;
        }
        if (section === 'theme') {
            return `thymer-backup-themes-${wsName}-${ts}.css`;
        }
        return `thymer-backup-plugins-${wsName}-${ts}.json`;
    }

    /** Auto-export full backup using whichever destination mode is active. */
    async _autoExport() {
        if (!this._autoExportEnabled) return;

        // Debounce rapid successive calls (e.g. update-all loop)
        if (this._autoExportTimer) clearTimeout(this._autoExportTimer);
        this._autoExportTimer = setTimeout(() => { this._autoExportTimer = null; this._runAutoExport(); }, 400);
    }

    async _runAutoExport() {
        try {
            const data = await this._getExportData();
            const jsonStr = JSON.stringify(this._buildExportPayload('all', data), null, 2);
            const filename = this._getBackupJsonFilename('all');
            const mode = this._autoExportMode || (this._autoExportDirHandle ? 'fsaccess' : '');

            if (mode === 'fsaccess' && this._autoExportDirHandle) {
                const perm = await this._autoExportDirHandle.requestPermission({ mode: 'readwrite' });
                if (perm !== 'granted') {
                    console.warn('[Plugins Manager] Auto-export: write permission denied.');
                    return;
                }
                const fileHandle = await this._autoExportDirHandle.getFileHandle(filename, { create: true });
                const writable = await fileHandle.createWritable();
                await writable.write(jsonStr);
                await writable.close();
                console.log(`[Plugins Manager] Auto-exported backup to ${this._autoExportDirName}/${filename}`);
                return;
            }

            if (mode === 'download') {
                this._triggerDownload(filename, jsonStr, 'application/json');
                console.log(`[Plugins Manager] Auto-exported backup as download: ${filename}`);
                return;
            }

            console.warn('[Plugins Manager] Auto-export enabled but no destination is configured.');
        } catch (e) {
            console.error('[Plugins Manager] Auto-export failed:', e);
            this.ui.addToaster({ title: "Auto-Backup Failed", message: e.message, autoDestroyTime: 6000, dismissible: true });
        }
    }

    /** Detect available auto-export destinations in this runtime. */
    _detectAutoExportCaps() {
        const caps = { hasFSAccess: false, canDownload: true };
        try {
            const isElectron = typeof navigator !== 'undefined' &&
                (navigator.userAgent.toLowerCase().indexOf(' electron/') > -1 ||
                    navigator.userAgent.toLowerCase().indexOf('thymer') > -1);
            caps.hasFSAccess = !isElectron && typeof window !== 'undefined' && typeof window.showDirectoryPicker === 'function';
        } catch (e) { }
        // Downloads work in any environment that provides URL.createObjectURL + <a download>
        try { caps.canDownload = typeof URL !== 'undefined' && typeof URL.createObjectURL === 'function'; } catch (e) { caps.canDownload = false; }
        return caps;
    }

    _autoExportDestinationLabel() {
        if (this._autoExportMode === 'fsaccess' && this._autoExportDirName) return '📁 ' + this._autoExportDirName;
        if (this._autoExportMode === 'download') return '⬇ Downloads folder (per-change)';
        // Legacy state: dir name saved but mode not set → treat as fsaccess
        if (this._autoExportDirName) return '📁 ' + this._autoExportDirName;
        return 'No destination selected';
    }

    _autoExportModeHint() {
        if (this._autoExportCaps.hasFSAccess) {
            return 'Backups are written directly to the chosen folder.';
        }
        if (this._autoExportCaps.canDownload) {
            return 'Folder picker is unavailable in this build; backups will be saved via browser download to your Downloads folder on each change.';
        }
        return 'Automatic backups are not available in this runtime.';
    }

    /** Prompt for destination, adapting to runtime capabilities. */
    async _chooseAutoExportTarget(container) {
        if (this._choosingDir) return;
        this._choosingDir = true;
        try {
            // If already set, offer to clear/reset it first
            if (this._autoExportMode) {
                const clear = await this._showConfirmModal('Reset Backup Destination', `Current destination: ${this._autoExportDestinationLabel()}\n\nWould you like to clear this destination?`, { confirmText: 'Clear Destination', cancelText: 'Keep Destination', danger: true });
                if (clear) {
                    this._autoExportDirHandle = null;
                    this._autoExportDirName = '';
                    this._autoExportMode = '';
                    this._autoExportEnabled = false;
                    localStorage.removeItem('pm_auto_export_mode');
                    localStorage.removeItem('pm_auto_export_dir_name');
                    localStorage.setItem('pm_auto_export', 'false');

                    try {
                        const req = indexedDB.open('plugin-manager-db', 1);
                        req.onsuccess = (e) => {
                            const db = e.target.result;
                            const tx = db.transaction('handles', 'readwrite');
                            tx.objectStore('handles').delete('autoExportDir');
                        };
                    } catch (e) { }

                    if (container) {
                        const lbl = container.querySelector('#pm-auto-export-dir-label');
                        if (lbl) lbl.textContent = 'No destination selected';
                        const toggle = container.querySelector('#pm-auto-export-toggle');
                        if (toggle) toggle.checked = false;
                        const hint = container.querySelector('#pm-auto-export-mode-help');
                        if (hint) hint.textContent = this._autoExportModeHint();
                        this._renderWorkspaceSummary(container);
                    }
                    await this._saveManagerSettings({ autoExportEnabled: false });
                    this.ui.addToaster({ title: 'Destination Cleared', message: 'Automatic backups have been disabled.', autoDestroyTime: 3000, dismissible: true });
                    return;
                }
            }

            // Re-detect (in case the build updated between sessions)
            this._autoExportCaps = this._detectAutoExportCaps();

            if (this._autoExportCaps.hasFSAccess) {
                try {
                    const handle = await window.showDirectoryPicker({ mode: 'readwrite' });
                    this._autoExportDirHandle = handle;
                    this._autoExportDirName = handle.name;
                    this._autoExportMode = 'fsaccess';
                    localStorage.setItem('pm_auto_export_dir_name', handle.name);
                    localStorage.setItem('pm_auto_export_mode', 'fsaccess');
                    try {
                        await this._storeAutoExportHandle(handle);
                    } catch (storeError) {
                        console.warn('[Plugins Manager] Failed to store directory handle in IndexedDB:', storeError);
                    }
                    await this._applyAutoExportUI(container, 'Directory Set', `Backups will save to: ${handle.name}`);
                } catch (e) {
                    if (e && e.name !== 'AbortError') {
                        // Some desktop builds expose showDirectoryPicker but it throws NotAllowedError; fall back.
                        console.warn('[Plugins Manager] showDirectoryPicker failed, falling back to download mode:', e);
                        try {
                            this.ui.addToaster({ title: "Folder Picker Error", message: e.message, autoDestroyTime: 6000, dismissible: true });
                        } catch (toasterErr) { }
                        this._autoExportCaps.hasFSAccess = false;
                        await this._offerDownloadFallback(container, e.message);
                    }
                }
                return;
            }

            if (this._autoExportCaps.canDownload) {
                await this._offerDownloadFallback(container);
                return;
            }

            this.ui.addToaster({
                title: "Not Supported",
                message: "This runtime does not expose a way to save files. Please use the Backup Workspace button manually.",
                autoDestroyTime: 6000,
                dismissible: true
            });
        } finally {
            this._choosingDir = false;
        }
    }

    async _offerDownloadFallback(container, originalError = '') {
        const msg = 'Folder picker is not available in this build (common on the Thymer desktop app). '
            + 'Enable "download backup on each change" instead? Files will land in your Downloads folder.'
            + (originalError ? `\n\n(Reason: ${originalError})` : '');
        if (!await this._showConfirmModal('Please confirm', msg, { confirmText: 'Continue' })) return;
        this._autoExportDirHandle = null;
        this._autoExportDirName = '';
        this._autoExportMode = 'download';
        localStorage.setItem('pm_auto_export_mode', 'download');
        localStorage.removeItem('pm_auto_export_dir_name');
        this._applyAutoExportUI(container, 'Auto-Download Enabled', 'Backups will download on each change.');
    }

    async _applyAutoExportUI(container, toastTitle, toastMessage) {
        if (container) {
            const lbl = container.querySelector('#pm-auto-export-dir-label');
            if (lbl) lbl.textContent = this._autoExportDestinationLabel();
            const btn = container.querySelector('#pm-auto-export-dir-btn');
            if (btn) btn.textContent = this._autoExportCaps.hasFSAccess ? 'Choose Directory' : 'Choose Destination';
            const hint = container.querySelector('#pm-auto-export-mode-help');
            if (hint) hint.textContent = this._autoExportModeHint();
            const toggle = container.querySelector('#pm-auto-export-toggle');
            if (toggle) toggle.checked = true;
        }
        this._autoExportEnabled = true;
        localStorage.setItem('pm_auto_export', 'true');
        await this._saveManagerSettings({ autoExportEnabled: true });
        if (container) this._renderWorkspaceSummary(container);
        this.ui.addToaster({ title: toastTitle, message: toastMessage, autoDestroyTime: 3000, dismissible: true });
    }

    /** Trigger a blob download via an ephemeral anchor. */
    _triggerDownload(filename, content, mimeType = 'application/json') {
        const blob = new Blob([content], { type: mimeType });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        a.style.display = 'none';
        document.body.appendChild(a);
        a.click();
        setTimeout(() => {
            try { document.body.removeChild(a); } catch (e) { }
            try { URL.revokeObjectURL(url); } catch (e) { }
        }, 1500);
    }

    /** Store directory handle in IndexedDB for persistence across sessions */
    async _storeAutoExportHandle(handle) {
        return new Promise((resolve, reject) => {
            const req = indexedDB.open('plugin-manager-db', 1);
            req.onupgradeneeded = (e) => { e.target.result.createObjectStore('handles'); };
            req.onsuccess = (e) => {
                const db = e.target.result;
                const tx = db.transaction('handles', 'readwrite');
                tx.objectStore('handles').put(handle, 'autoExportDir');
                tx.oncomplete = () => resolve();
                tx.onerror = () => reject(tx.error);
            };
            req.onerror = () => reject(req.error);
        });
    }

    /** Restore directory handle from IndexedDB */
    async _restoreAutoExportHandle() {
        try {
            const handle = await new Promise((resolve, reject) => {
                const req = indexedDB.open('plugin-manager-db', 1);
                req.onupgradeneeded = (e) => { e.target.result.createObjectStore('handles'); };
                req.onsuccess = (e) => {
                    const db = e.target.result;
                    const tx = db.transaction('handles', 'readonly');
                    const getReq = tx.objectStore('handles').get('autoExportDir');
                    getReq.onsuccess = () => resolve(getReq.result || null);
                    getReq.onerror = () => reject(getReq.error);
                };
                req.onerror = () => reject(req.error);
            });
            if (handle) this._autoExportDirHandle = handle;
        } catch (e) {
            console.warn('[Plugins Manager] Could not restore auto-export directory handle:', e);
        }
    }

    // --- Utilities ---

    _cloneJsonValue(value) {
        if (value === undefined) return undefined;
        return JSON.parse(JSON.stringify(value));
    }

    /** Validate JS code is compatible with Thymer's runtime before saving */
    _validatePluginJS(name, jsCode) {
        if (!jsCode) return;
        if (/^\s*import\s+/m.test(jsCode) || /^\s*export\s+/m.test(jsCode)) {
            throw new Error(`"${name || 'Unknown'}" uses ES module syntax (import/export) which is not compatible with Thymer's plugin system.`);
        }
        // Security: removed new Function(jsCode) — it compiles arbitrary code pre-install.
        // Thymer's own runtime will surface syntax errors when the plugin loads.
    }

    /**
     * Never save a plugin config without an identity. Thymer stamps a config
     * saved without `name` as "New Global Plugin" (permanently renaming the
     * plugin), and a save missing `__source_repo` silently drops the plugin off
     * the update list. Falls back to the existing config's identity fields,
     * and refuses the save outright if no name can be resolved.
     */
    _ensurePluginIdentity(conf, existingConf) {
        if ((typeof conf.name !== 'string' || !conf.name.trim())
            && existingConf && typeof existingConf.name === 'string' && existingConf.name.trim()) {
            conf.name = existingConf.name;
        }
        if (typeof conf.name !== 'string' || !conf.name.trim()) {
            throw new Error('Plugin config has no "name" — refusing to save a nameless config.');
        }
        if (existingConf) {
            if (conf.__source_repo === undefined && existingConf.__source_repo !== undefined) {
                conf.__source_repo = existingConf.__source_repo;
            }
            if (conf.__source_files === undefined && existingConf.__source_files !== undefined) {
                conf.__source_files = this._cloneJsonValue(existingConf.__source_files);
            }
        }
        return conf;
    }

    /** Security: Whitelist allowed plugin.json config keys and enforce size limits */
    _sanitizePluginConfig(jsonConf, { allowCustom = false, preserveUnknownKeys = false } = {}) {
        if (preserveUnknownKeys) {
            const sanitized = this._cloneJsonValue(jsonConf || {});
            if (!allowCustom) delete sanitized.custom;
            if (allowCustom && sanitized.custom !== undefined) {
                const customJson = JSON.stringify(sanitized.custom);
                if (customJson.length > 200 * 1024) {
                    throw new Error(`"${jsonConf.name || 'Unknown'}" settings exceed the 200KB backup limit.`);
                }
            }
            return sanitized;
        }

        const ALLOWED_KEYS = ['name', 'type', 'description', 'version', 'icon', 'permissions', '__source_repo', '__source_files', 'ver'];
        const COLLECTION_SCHEMA_KEYS = ['color', 'item_name', 'show_sidebar_items', 'show_cmdpal_items',
            'sidebar_action', 'fields', 'views', 'page_field_ids', 'sidebar_record_sort_field_id',
            'sidebar_record_sort_dir', 'managed', 'home', 'related_query', 'default_banner'];
        const sanitized = {};
        for (const key of ALLOWED_KEYS) {
            if (jsonConf[key] !== undefined) {
                sanitized[key] = jsonConf[key];
            }
        }
        const isCollection = (jsonConf.type || '').toLowerCase() === 'collection';
        if (isCollection) {
            for (const key of COLLECTION_SCHEMA_KEYS) {
                if (jsonConf[key] !== undefined) {
                    sanitized[key] = jsonConf[key];
                }
            }
        }
        if (allowCustom && jsonConf.custom !== undefined) {
            const customJson = JSON.stringify(jsonConf.custom);
            if (customJson.length > 200 * 1024) {
                throw new Error(`"${jsonConf.name || 'Unknown'}" settings exceed the 200KB backup limit.`);
            }
            sanitized.custom = JSON.parse(customJson);
        }
        return sanitized;
    }

    /** Security: Strip dangerous CSS constructs that could exfiltrate data or execute scripts */
    _sanitizeCSS(cssText) {
        if (!cssText) return cssText;
        let sanitized = cssText;
        const warnings = [];

        // Strip @import rules (could load external resources/tracking pixels)
        if (/@import\s/i.test(sanitized)) {
            sanitized = sanitized.replace(/@import\s[^;]*;?/gi, '/* [removed @import] */');
            warnings.push('@import rules were removed for security');
        }

        // Strip expression() calls (IE script execution vector)
        if (/expression\s*\(/i.test(sanitized)) {
            sanitized = sanitized.replace(/expression\s*\([^)]*\)/gi, '/* [removed expression()] */');
            warnings.push('expression() calls were removed for security');
        }

        // Warn about external url() references (don't block — legitimate for fonts)
        const externalUrls = sanitized.match(/url\s*\(\s*['"]?https?:\/\//gi);
        if (externalUrls && externalUrls.length > 0) {
            warnings.push(`${externalUrls.length} external url() reference(s) found — review these if you did not author this theme`);
        }

        if (warnings.length > 0) {
            this.ui.addToaster({
                title: 'CSS Security Notice',
                message: warnings.join('. ') + '.',
                autoDestroyTime: 6000,
                dismissible: true
            });
        }

        return sanitized;
    }

    /** Escape HTML entities to prevent XSS when injecting user-controlled strings into innerHTML */
    _escHtml(str) {
        return String(str ?? '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    /** Validate that a URL points to github.com over HTTPS */
    _isValidGithubUrl(url) {
        return /^https:\/\/github\.com\/[^\/]+\/[^\/]+/.test(url);
    }

    // --- GitHub Utils ---

    /**
     * Parse a GitHub URL into owner, repo, and optional subpath.
     * Supports:
     *   https://github.com/user/repo
     *   https://github.com/user/repo/tree/branch/path/to/subfolder
     *   https://github.com/user/repo/tree/branch/path/to/file.json  (extracts parent dir)
     *   https://github.com/user/repo/blob/branch/path/to/file.json  (extracts parent dir)
     *   https://github.com/user/repo/releases  (strips to owner/repo)
     *   https://github.com/user/repo/issues, /pulls, /wiki, etc.
     */
    _parseGithubUrl(url) {
        // Normalize SSH URLs: git@github.com:user/repo.git → https://github.com/user/repo
        url = url.replace(/^git@github\.com:/, 'https://github.com/').replace(/\.git$/, '');
        // First, strip known GitHub page paths that don't point to code
        const githubPages = /\/(releases|issues|pulls|wiki|actions|settings|discussions|tags|commit|compare|security|projects|milestones|labels|pulse|graphs|network|community)(\/.*)?$/;
        const cleanUrl = url.replace(githubPages, '');

        // Match URLs with /tree/ or /blob/ paths
        const treeMatch = cleanUrl.match(/github\.com\/([^\/]+)\/([^\/]+?)(?:\.git)?(?:\/(?:tree|blob)\/[^\/]+\/(.+?))?\/?\s*$/);
        if (!treeMatch) return { owner: null, repo: null, subpath: '' };

        let subpath = treeMatch[3] || '';

        // If subpath ends with a file extension, strip the filename to get its directory
        if (subpath && /\.[a-zA-Z0-9]+$/.test(subpath)) {
            const lastSlash = subpath.lastIndexOf('/');
            subpath = lastSlash > 0 ? subpath.substring(0, lastSlash) : '';
        }

        return {
            owner: treeMatch[1],
            repo: treeMatch[2],
            subpath: subpath
        };
    }

    /**
     * List files in a GitHub repository directory via the API.
     * Falls back through branches (main, master).
     */
    async _listRepoDirectory(owner, repo, subpath) {
        const apiHeaders = {
            'Accept': 'application/vnd.github.v3+json',
            'X-GitHub-Api-Version': '2022-11-28'
        };
        if (this.githubPat) apiHeaders['Authorization'] = `Bearer ${this.githubPat}`;

        const path = subpath || '';
        const apiUrl = `https://api.github.com/repos/${owner}/${repo}/contents/${path}`;

        const res = await fetch(apiUrl, { headers: apiHeaders });
        if (!res.ok) {
            const statusText = res.statusText || 'Unknown';
            throw new Error(`GitHub API ${res.status} (${statusText}): ${owner}/${repo}/${path}`);
        }

        const files = await res.json();
        if (!Array.isArray(files)) throw new Error("Path is not a directory");
        return files;
    }

    /**
     * Intelligently find a file by its role (json, js, css) from a directory listing.
     *
     * Priority order:
     * 1. Exact standard names: plugin.json, plugin.js, plugin.css
     * 2. Files with `-plugin` suffix: clock-plugin.json, clock-plugin.js
     * 3. Files with correct extension: *.json, *.js, *.css
     * 4. Extensionless Thymer export files by name heuristic:
     *    - json: "Config" or any file whose content parses as JSON
     *    - js:   "Custom Code" or file containing "extends AppPlugin"/"extends CollectionPlugin"
     *    - css:  "Custom CSS" or "Custom Style"
     */
    _findFileByRole(files, role) {
        const onlyFiles = files.filter(f => f.type === 'file');

        const extMap = { json: '.json', js: '.js', css: '.css' };
        const stdName = `plugin${extMap[role]}`;

        // 1. Exact standard name
        const exact = onlyFiles.find(f => f.name.toLowerCase() === stdName);
        if (exact) return exact;

        // 2. Files with *-plugin suffix
        const pluginSuffix = onlyFiles.find(f => f.name.toLowerCase().endsWith(`-plugin${extMap[role]}`));
        if (pluginSuffix) return pluginSuffix;

        // 3. Files with the correct extension
        const byExt = onlyFiles.filter(f => f.name.toLowerCase().endsWith(extMap[role]));
        if (byExt.length === 1) return byExt[0]; // Unambiguous single match
        // If multiple, prefer one containing 'plugin' in the name
        if (byExt.length > 1) {
            const withPlugin = byExt.find(f => f.name.toLowerCase().includes('plugin'));
            if (withPlugin) return withPlugin;
            return byExt[0]; // Fallback to first
        }

        // 4. Extensionless files by naming convention (e.g., Thymer export format)
        const nameHeuristics = {
            json: ['config'],
            js: ['custom code', 'code'],
            css: ['custom css', 'custom style', 'style', 'css']
        };

        const heuristic = nameHeuristics[role] || [];
        for (const hint of heuristic) {
            const match = onlyFiles.find(f => f.name.toLowerCase() === hint && !f.name.includes('.'));
            if (match) return match;
        }

        // 5. (CSS only) Extensionless files containing "css" in the name (e.g., "theme-name-css")
        if (role === 'css') {
            const cssInName = onlyFiles.filter(f => !f.name.includes('.') && f.name.toLowerCase().includes('css'));
            if (cssInName.length === 1) return cssInName[0];
            if (cssInName.length > 1) {
                const preferred = cssInName.find(f => /theme|style/i.test(f.name));
                return preferred || cssInName[0];
            }
        }

        return null;
    }

    /**
     * Simple heuristic to detect if text content is likely CSS.
     * Checks for CSS rule blocks and common CSS patterns while rejecting JS/JSON.
     */
    _looksLikeCSS(text) {
        if (!text || text.length < 10) return false;
        const sample = text.substring(0, 2000);
        if (!sample.includes('{') || !sample.includes('}')) return false;
        // Reject obvious non-CSS (JavaScript / JSON)
        if (/\b(function|const |let |var |module\.exports|require\(|import )\b/.test(sample)) return false;
        // Check for CSS-like content
        return /(:root|@media|@import|@font-face|color\s*:|background|font-|margin|padding|display\s*:|--[\w-]+\s*:)/i.test(sample);
    }

    async _fetchGithubFile(owner, repo, branch, path) {
        // Use API when PAT is available (required for private repos), else raw URL
        if (this.githubPat) {
            const apiUrl = `https://api.github.com/repos/${owner}/${repo}/contents/${path}?ref=${branch}`;
            const res = await fetch(apiUrl, {
                headers: {
                    'Authorization': `Bearer ${this.githubPat}`,
                    'Accept': 'application/vnd.github.v3.raw'
                }
            });
            if (!res.ok) throw new Error(`Failed to fetch ${path} (${res.status})`);
            return await res.text();
        }

        const rawUrl = `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${path}`;
        const res = await fetch(rawUrl);
        if (!res.ok) throw new Error(`Failed to fetch ${path} (${res.status})`);
        return await res.text();
    }

    async fetchGithubRepo(url, { sourceFiles } = {}) {
        if (!this._isValidGithubUrl(url)) throw new Error("URL must point to github.com");
        const { owner, repo, subpath } = this._parseGithubUrl(url);
        if (!owner || !repo) throw new Error("Invalid GitHub URL. Expected format: https://github.com/user/repo");

        // PAT auth headers — only for api.github.com, NOT for raw.githubusercontent.com (triggers CORS preflight)
        const apiHeaders = {
            'Accept': 'application/vnd.github.v3+json',
            'X-GitHub-Api-Version': '2022-11-28'
        };
        if (this.githubPat) {
            apiHeaders['Authorization'] = `Bearer ${this.githubPat}`;
        }

        const prefix = subpath ? `${subpath}/` : '';
        const label = `${owner}/${repo}${subpath ? '/' + subpath : ''}`;

        // Helper: build __source_files metadata for caching discovered filenames
        const buildSourceFiles = (branch, jsonName, jsName, cssName) => {
            const sf = { branch, json: jsonName, js: jsName };
            if (cssName) sf.css = cssName;
            return sf;
        };

        // ----- Strategy 0: Use cached filenames from a previous discovery (fastest — no probing needed) -----
        if (sourceFiles && sourceFiles.branch && sourceFiles.json && sourceFiles.js) {
            try {
                const pluginJson = JSON.parse(await this._fetchGithubFile(owner, repo, sourceFiles.branch, `${prefix}${sourceFiles.json}`));
                const pluginJs = await this._fetchGithubFile(owner, repo, sourceFiles.branch, `${prefix}${sourceFiles.js}`);
                pluginJson.__source_repo = url;
                pluginJson.__source_files = buildSourceFiles(sourceFiles.branch, sourceFiles.json, sourceFiles.js, sourceFiles.css);
                const result = { json: pluginJson, js: pluginJs };
                if (sourceFiles.css) {
                    try {
                        result.css = await this._fetchGithubFile(owner, repo, sourceFiles.branch, `${prefix}${sourceFiles.css}`);
                    } catch (e) { /* CSS is optional */ }
                }
                return result;
            } catch (e) { /* cached names failed, fall through to full discovery */ }
        }

        // ----- Strategy 1: Try common filename patterns via raw.githubusercontent.com (fast, no API needed) -----
        // Build candidate filename lists based on common conventions:
        //   - Standard: plugin.json / plugin.js
        //   - SDK pattern: {repo}-plugin.json / {repo}-plugin.js
        //   - Thymer export names (extensionless): Config / Custom Code
        const jsonCandidates = ['plugin.json', `${repo}-plugin.json`, 'Config'];
        const jsCandidates = ['plugin.js', `${repo}-plugin.js`, 'Custom Code'];

        for (const branch of ['main', 'master']) {
            // Try each JSON candidate until one responds OK
            let foundJson = null;
            let foundJsonName = null;
            for (const jsonName of jsonCandidates) {
                try {
                    const text = await this._fetchGithubFile(owner, repo, branch, `${prefix}${jsonName}`);
                    try {
                        foundJson = JSON.parse(text);
                        foundJsonName = jsonName;
                        break;
                    } catch (e) { /* not valid JSON, try next */ }
                } catch (e) { /* try next */ }
            }
            if (!foundJson) continue;

            // Try each JS candidate until one responds OK
            for (const jsName of jsCandidates) {
                try {
                    const pluginJs = await this._fetchGithubFile(owner, repo, branch, `${prefix}${jsName}`);
                    foundJson.__source_repo = url;

                    // Also try to grab CSS while we're here
                    const cssCandidates = ['plugin.css', 'styles.css', `${repo}-plugin.css`, 'Custom CSS'];
                    const result = { json: foundJson, js: pluginJs };
                    let foundCssName = null;
                    for (const cssName of cssCandidates) {
                        try {
                            result.css = await this._fetchGithubFile(owner, repo, branch, `${prefix}${cssName}`);
                            foundCssName = cssName;
                            break;
                        } catch (e) { /* CSS is optional */ }
                    }

                    // Cache the discovered filenames for future fetches
                    foundJson.__source_files = buildSourceFiles(branch, foundJsonName, jsName, foundCssName);
                    return result;
                } catch (e) { /* try next */ }
            }
        }

        // ----- Strategy 2: Use GitHub API to discover files in the directory -----
        let files;
        try {
            files = await this._listRepoDirectory(owner, repo, subpath);
        } catch (e) {
            const reason = e.message || 'Unknown error';
            throw new Error(`Could not find plugin files in ${label}. Standard names (plugin.json/plugin.js) not found, and directory listing failed: ${reason}`);
        }

        // Find the JSON config file
        const jsonFile = this._findFileByRole(files, 'json');
        if (!jsonFile) throw new Error(`No config file (.json) found in ${label}`);

        // Find the JS code file
        const jsFile = this._findFileByRole(files, 'js');
        if (!jsFile) throw new Error(`No code file (.js) found in ${label}`);

        // Fetch the actual file contents
        const jsonRes = await fetch(jsonFile.download_url);
        if (!jsonRes.ok) throw new Error(`Failed to download ${jsonFile.name}`);

        let pluginJson;
        const jsonText = await jsonRes.text();
        try {
            pluginJson = JSON.parse(jsonText);
        } catch (e) {
            throw new Error(`${jsonFile.name} is not valid JSON`);
        }

        const jsRes = await fetch(jsFile.download_url);
        if (!jsRes.ok) throw new Error(`Failed to download ${jsFile.name}`);
        const pluginJs = await jsRes.text();

        // Optionally grab CSS
        const cssFile = this._findFileByRole(files, 'css');

        pluginJson.__source_repo = url;
        // Cache discovered filenames — detect branch from download_url
        const branchMatch = jsonFile.download_url && jsonFile.download_url.match(/raw\.githubusercontent\.com\/[^/]+\/[^/]+\/([^/]+)\//);
        pluginJson.__source_files = buildSourceFiles(
            branchMatch ? branchMatch[1] : 'main',
            jsonFile.name,
            jsFile.name,
            cssFile ? cssFile.name : null
        );

        const result = { json: pluginJson, js: pluginJs };
        if (cssFile) {
            try {
                const cssRes = await fetch(cssFile.download_url);
                if (cssRes.ok) result.css = await cssRes.text();
            } catch (e) { /* CSS is optional */ }
        }

        return result;
    }

    // --- Core Features ---

    async showInstallDialog(container, typeFilter) {
        const label = typeFilter === 'app' ? 'Plugin' : 'Collection Plugin';
        const url = await this._showPromptModal(`Install ${label}`, `Enter GitHub URL for the ${label} (e.g. https://github.com/user/repo):`);
        if (!url) return;

        try {
            this.ui.addToaster({ title: "Fetching plugin...", autoDestroyTime: 2000, dismissible: true });
            const { json, js, css } = await this.fetchGithubRepo(url);

            // Validate type
            let pType = json.type;
            if (!pType) {
                if (/extends\s+AppPlugin/.test(js)) pType = "app";
                else if (/extends\s+(CollectionPlugin|JournalCorePlugin)/.test(js)) pType = "collection";
            }

            const isGlobal = pType === 'app' || pType === 'global';
            const filterIsGlobal = typeFilter === 'app';

            if (isGlobal !== filterIsGlobal) {
                if (!await this._showConfirmModal('Type mismatch', `This repository appears to be a ${isGlobal ? 'Plugin' : 'Collection Plugin'}, but you are trying to install it as a ${filterIsGlobal ? 'Plugin' : 'Collection Plugin'}.\nContinue anyway?`, { confirmText: 'Install anyway', danger: true })) {
                    return;
                }
            }

            await this.installPlugin(json, js, { cssCode: css });
            this.ui.addToaster({ title: `Successfully installed ${json.name}`, autoDestroyTime: 3000, dismissible: true });
            this.loadPlugins(container);
        } catch (err) {
            this.ui.addToaster({ title: "Install Failed", message: err.message, autoDestroyTime: 5000, dismissible: true });
        }
    }

    async installPlugin(jsonConf, jsCode, { interactive = true, cssCode = null, trustedConfig = false, allowRestoredCustom = false } = {}) {
        // Skip the Plugins Manager itself — it doesn't need to be reinstalled
        const name = (jsonConf.name || '').toLowerCase();
        if (name === 'plugins manager') {
            return 'skipped';
        }

        // Check for duplicates
        const allGlobals = await this.data.getAllGlobalPlugins();
        const allCollections = await this.data.getAllCollections();

        const existingPlugin = [...allGlobals, ...allCollections].find(p => {
            try {
                const conf = p.getExistingCodeAndConfig().json;
                // Match either by strict repo URL or exact name
                return (jsonConf.__source_repo && conf.__source_repo === jsonConf.__source_repo) || conf.name === jsonConf.name;
            } catch (e) {
                return false;
            }
        });

        let targetPlugin = null;

        // Determine the type early so we know how to handle existing plugins
        let pType = jsonConf.type;
        if (!pType) {
            if (/extends\s+AppPlugin/.test(jsCode)) {
                pType = "app";
            } else if (/extends\s+(CollectionPlugin|JournalCorePlugin)/.test(jsCode)) {
                pType = "collection";
            }
        }
        if (!pType || (pType !== 'app' && pType !== 'global' && pType !== 'collection')) {
            if (!interactive) {
                pType = 'app';
            } else {
                const choice = await this._showConfirmModal('Which type is this?', `Could not auto-detect the type for "${jsonConf.name || 'Unknown'}".\nInstall it as a Plugin, or as a Collection Plugin?`, { confirmText: 'Plugin', cancelText: 'Collection Plugin' });
                pType = choice ? 'app' : 'collection';
            }
        }

        if (existingPlugin) {
            if (!interactive || await this._showConfirmModal('Already installed', `"${jsonConf.name}" already exists. Update/overwrite with the imported version?`, { confirmText: 'Overwrite', danger: true })) {
                targetPlugin = existingPlugin;
            } else {
                return 'skipped';
            }
        }

        let existingConf = null;
        if (targetPlugin) {
            try {
                existingConf = targetPlugin.getExistingCodeAndConfig().json;
            } catch (e) { }
        }

        // Validate EVERYTHING before creating anything in the workspace, so a
        // failed install can never strand an empty container — it lingers as a
        // name-less "New Global Plugin" and looks like a broken install of
        // whatever the user grabbed.

        // Validate JS before saving — catch issues that would crash Thymer's runtime
        this._validatePluginJS(jsonConf.name, jsCode);

        // Security: sanitize config to only keep expected fields
        // A disabled-plugin restore may carry the exact `custom` blob we stashed from its prior
        // install. Let only that blob back through; unlike trusted backup imports, this does NOT
        // bypass the top-level config whitelist for newly fetched repository data.
        const sanitizedConf = this._sanitizePluginConfig(jsonConf, {
            allowCustom: trustedConfig || allowRestoredCustom,
            preserveUnknownKeys: trustedConfig,
        });
        if (existingConf && existingConf.custom !== undefined && (!trustedConfig || jsonConf.custom === undefined)) {
            sanitizedConf.custom = this._cloneJsonValue(existingConf.custom);
        }
        this._ensurePluginIdentity(sanitizedConf, existingConf);

        // Security: enforce code size limit (500KB)
        if (jsCode && jsCode.length > 500 * 1024) {
            throw new Error(`"${jsonConf.name || 'Unknown'}" code exceeds the 500KB size limit.`);
        }

        // For collections: remap filter_colguid for link-to-record fields before saving
        const pTypeNorm = (jsonConf.type || '').toLowerCase();
        if (pTypeNorm === 'collection' && Array.isArray(sanitizedConf.fields) && sanitizedConf.fields.length > 0) {
            const hasColNames = sanitizedConf.fields.some(f => f.filter_colname);
            if (hasColNames) {
                const allCollections = await this.data.getAllCollections();
                const nameToGuid = {};
                for (const tc of allCollections) {
                    try {
                        const tc_conf = tc.getConfiguration();
                        const tc_guid = tc.getGuid ? tc.getGuid() : null;
                        if (tc_guid && tc_conf && tc_conf.name) nameToGuid[tc_conf.name] = tc_guid;
                    } catch (e) { }
                }
                sanitizedConf.fields = sanitizedConf.fields.map(f => {
                    if (f.filter_colguid && nameToGuid[f.filter_colname]) {
                        const { filter_colname, ...rest } = f;
                        return { ...rest, filter_colguid: nameToGuid[f.filter_colname] };
                    }
                    const { filter_colname, ...rest } = f;
                    return rest;
                });
            }
        }

        let createdFresh = false;
        if (!targetPlugin) {
            if (pType === 'app' || pType === 'global') {
                targetPlugin = await this.data.createGlobalPlugin();
            } else if (pType === 'collection') {
                targetPlugin = await this.data.createCollection();
            }

            if (!targetPlugin) throw new Error("Failed to create plugin container in workspace.");
            createdFresh = true;
        }

        try {
            await targetPlugin.savePlugin(sanitizedConf, jsCode);
        } catch (e) {
            // Never strand a just-created container (see above) — trash it and
            // surface the original error.
            if (createdFresh) {
                try { await targetPlugin.trashPlugin(); } catch (cleanupErr) { /* best effort */ }
            }
            throw e;
        }

        // Security: sanitize and save CSS if provided
        if (cssCode) {
            const sanitizedCSS = this._sanitizeCSS(cssCode);
            await targetPlugin.saveCSS(sanitizedCSS);
        }

        this._autoExport(); // fire-and-forget
        return targetPlugin;
    }

    async _manualCheckForUpdates(container, filterType) {
        const btnId = filterType === 'app' ? '#pm-check-updates-global-btn' : '#pm-check-updates-col-btn';
        const btn = container.querySelector(btnId);
        if (!btn) return;

        const originalHtml = btn.innerHTML;
        btn.innerHTML = '';
        btn.appendChild(this.ui.createIcon('loader'));
        btn.disabled = true;

        try {
            // Same live toast as the palette command: rows reveal per plugin as the check
            // walks the list, then the toast settles in place with the outcome.
            this._toastProgress('Checking for updates…');
            await this.checkForAllUpdatesInBackground({ manual: true, notifyNew: false, announce: false });
            this.loadPlugins(container);
            const n = Object.keys(this._readUpdateCache()).length;
            this._setStatus({ final: true, finalTitle: n ? `${n} Update${n === 1 ? '' : 's'} Available` : PM_UP_TO_DATE_TITLE });
        } catch (e) {
            this._toastSummary('Update Check Failed', e.message);
        } finally {
            btn.innerHTML = originalHtml;
            btn.disabled = false;
        }
    }

    /**
     * ONE live status toast for the whole run, mutated in place.
     *
     * Thymer OVERLAYS toasters rather than queueing them, so a toast per step buries the previous
     * one and the stack becomes unreadable. addToaster() returns a PluginToaster with `element`,
     * and accepts `messageHTML` — so we inject a span we OWN and rewrite it, rather than pinning
     * to Thymer's internal toast classes. The toast is never recreated mid-run, so it can't
     * flicker or replay its enter animation on every state change.
     *
     * The update loop pushes state via _setStatus(); the bar redraws only when work actually
     * starts or settles.
     */
    _toastProgress(title, message) {
        // A completed toast may still be inside its five-second idle window. Reset every field
        // so a fresh run cannot inherit `final: true` or its pending auto-dismiss timer.
        this._setStatus({
            title,
            line: message || '',
            total: 0,
            done: 0,
            items: [],
            final: false,
            verb: '',
            verbDone: '',
            finalTitle: '',
        });
    }

    /**
     * @param {object} patch
     *   title  — the one headline: "Checking for updates…" → "Updating 3 plugins…" → "Everything up to date!"
     *   total  — >0 switches the body to a progress bar + per-plugin rows
     *   items  — [{ name, state: 'pending'|'active'|'done'|'failed', from, to }]
     *   done   — how many rows have settled (drives the bar)
     *   final  — terminal; leaves the completed toast up
     */
    _setStatus(patch) {
        this._status = Object.assign(
            { title: '', total: 0, done: 0, items: [], final: false, verb: '', verbDone: '', finalTitle: '' },
            this._status || {},
            patch
        );

        if (!this._progressToast) {
            try {
                this._progressToast = this.ui.addToaster({
                    title: this._status.title,
                    // pre-line inline (not in plugin.css) so newlines render without shipping a
                    // rule that would leak onto Thymer's toast chrome for every other plugin.
                    messageHTML: '<span class="pm-toast-status" style="white-space: pre-line"></span>',
                    dismissible: true,
                    // No native autoDestroyTime: its countdown would start NOW and could kill a
                    // long check mid-run. Our idle timer starts only when this toast becomes final.
                    primaryLabel: 'OK',
                    onPrimary: () => this._clearProgressToast(),
                });
                this._statusNode = this._progressToast.element.querySelector('.pm-toast-status');
                // The title has no markup hook of ours, so find it by the exact text we just
                // passed. If the structure ever changes we simply stop retitling — a toast is
                // never worth throwing over.
                this._titleNode = [...this._progressToast.element.querySelectorAll('*')]
                    .find(el => el.children.length === 0 && el.textContent.trim() === this._status.title) || null;
                this._bindStatusToastIdlePause(this._progressToast.element);
            } catch (e) {
                this._progressToast = null;
                return;
            }
        }

        this._renderStatus();
        if (this._status.final) this._scheduleStatusAutoDismiss();
        else this._cancelStatusAutoDismiss();
    }

    /** Update one row and redraw the toast from that single state change. */
    _markStatusItem(index, state, extra) {
        const s = this._status;
        if (!s || !s.items[index]) return;
        Object.assign(s.items[index], { state }, extra || {});
        // Failures still count as settled work in the headline total.
        s.done = s.items.filter(it => it.state === 'done' || it.state === 'failed').length;
        this._renderStatus();
    }


    /**
     * Terminal state. The toast stays exactly where it is — bar full, rows checked off, headline
     * settling to the supplied finale (or the derived completed count when there were failures) —
     * then dismisses after five seconds without hover or keyboard interaction.
     */
    _finishStatus(finalTitle = '') {
        // If the user hit OK mid-run, they're done with it — don't resurrect a fresh toast on them.
        if (!this._progressToast) return;
        this._setStatus({ final: true, finalTitle });
    }

    _renderStatus() {
        const s = this._status;
        if (!s) return;

        let title = s.title;
        const body = document.createDocumentFragment();
        // This one condition drives BOTH row opacity and its tally cell, keeping them in lockstep.
        // A finalized active row is treated as pending because it never actually settled.
        const isRevealed = it => it.state !== 'pending' && !(it.state === 'active' && s.final);

        if (s.total > 0) {
            // One cell per plugin — the bar IS the plugin count, so it reads as a tally rather
            // than an abstract percentage. Bigger than body text on purpose: it is the run's
            // headline gauge. A cell fills exactly when its matching row becomes opaque.
            const filled = Math.max(0, Math.min(s.total, s.items.filter(isRevealed).length));
            const cells = '▰'.repeat(filled) + '▱'.repeat(s.total - filled);
            const bar = document.createElement('div');
            bar.textContent = cells;
            bar.style.cssText = 'font-size:1.45em;letter-spacing:2px;line-height:1.2;margin-bottom:6px';
            body.appendChild(bar);

            const ok = s.items.filter(it => it.state === 'done').length;
            const bad = s.items.filter(it => it.state === 'failed').length;
            const settled = ok + bad;
            const verb = s.final ? (s.verbDone || 'Updated') : (s.verb || 'Updating');
            title = `${verb} (${settled}/${s.total}) Plugin${s.total === 1 ? '' : 's'}`;
            if (bad) title += ` • ${bad} Failed`;
        }
        // A finalize call may pin its own headline ("Everything up to date!").
        if (s.final && s.finalTitle) title = s.finalTitle;

        for (const it of s.items) {
            // A run cut short (self-update tears down our context) must not leave a row
            // active forever, so a finished status downgrades stragglers back to pending.
            let mark = '·';                                      // pending
            if (it.state === 'done') mark = '✓';
            else if (it.state === 'failed') mark = '✗';
            else if (it.state === 'active') mark = s.final ? '·' : '•';

            const row = document.createElement('div');
            // Pending rows sit dim; the row under the traveling • (and everything settled)
            // is full strength — so progress reads as brightness moving down the list.
            if (!isRevealed(it)) row.style.opacity = '0.55';
            // Mark leads the row in a fixed-width column: aligns for free, no padding math,
            // no dependence on a monospace face.
            const markEl = document.createElement('span');
            markEl.style.cssText = 'display:inline-block;width:1.4em';
            markEl.textContent = mark;
            // With an update: "v1.2.3 → v1.2.5". Without: just the current version.
            // Target version comes from the update cache at seed time, so a row that FAILS
            // still names the version it failed to reach.
            const ver = it.to ? `v${it.from || '?'} → v${it.to}` : (it.version ? `v${it.version}` : '');
            const textEl = document.createElement('span');
            textEl.textContent = `${it.name}${ver ? ' — ' + ver : ''}`;
            row.append(markEl, textEl);
            body.appendChild(row);
        }

        try {
            if (this._titleNode) {
                // The bar and traveling row marker carry live motion; keep the headline still.
                this._titleNode.textContent = title;
            }
            if (this._statusNode) this._statusNode.replaceChildren(body);
        } catch (e) { }
    }

    /** Pause final-toast dismissal while the user is hovering it or focused inside it. */
    _bindStatusToastIdlePause(element) {
        if (!element || typeof element.addEventListener !== 'function') return;

        const interaction = { pointer: false, focus: false };
        this._statusToastInteraction = interaction;
        const sync = () => {
            if (interaction.pointer || interaction.focus) this._cancelStatusAutoDismiss();
            else this._scheduleStatusAutoDismiss();
        };
        const onPointerEnter = () => { interaction.pointer = true; sync(); };
        const onPointerLeave = () => { interaction.pointer = false; sync(); };
        const onFocusIn = () => { interaction.focus = true; sync(); };
        const onFocusOut = (event) => {
            if (typeof element.contains !== 'function' || !element.contains(event.relatedTarget)) {
                interaction.focus = false;
                sync();
            }
        };

        element.addEventListener('pointerenter', onPointerEnter);
        element.addEventListener('pointerleave', onPointerLeave);
        element.addEventListener('focusin', onFocusIn);
        element.addEventListener('focusout', onFocusOut);
        this._statusToastInteractionCleanup = () => {
            element.removeEventListener('pointerenter', onPointerEnter);
            element.removeEventListener('pointerleave', onPointerLeave);
            element.removeEventListener('focusin', onFocusIn);
            element.removeEventListener('focusout', onFocusOut);
        };
    }

    _scheduleStatusAutoDismiss() {
        this._cancelStatusAutoDismiss();
        const interaction = this._statusToastInteraction;
        if (!this._progressToast || !this._status?.final || interaction?.pointer || interaction?.focus) return;
        this._statusAutoDismissTimer = setTimeout(() => {
            this._statusAutoDismissTimer = null;
            this._clearProgressToast();
        }, PM_STATUS_TOAST_IDLE_MS);
    }

    _cancelStatusAutoDismiss() {
        if (this._statusAutoDismissTimer != null) clearTimeout(this._statusAutoDismissTimer);
        this._statusAutoDismissTimer = null;
    }

    _clearProgressToast() {
        this._cancelStatusAutoDismiss();
        try { if (this._statusToastInteractionCleanup) this._statusToastInteractionCleanup(); } catch (e) { }
        this._statusToastInteractionCleanup = null;
        this._statusToastInteraction = null;
        try { if (this._progressToast) this._progressToast.destroy(); } catch (e) { }
        this._progressToast = null;
        this._statusNode = null;
        this._titleNode = null;
        this._status = null;
    }

    /**
     * Final report: ONE toast, listing everything that changed, that stays until dismissed.
     * No autoDestroyTime — a summary that vanishes before it's read is worse than none.
     */
    _toastSummary(title, message) {
        this._clearProgressToast();
        try {
            let t;
            t = this.ui.addToaster({
                title,
                message: message || '',
                dismissible: true,
                primaryLabel: 'OK',
                onPrimary: () => { try { if (t) t.destroy(); } catch (e) { } },
            });
        } catch (e) { }
    }

    /** Panel path: resolve the tab's Update All button, then hand off to the headless core. */
    async _updateAllAvailable(container, filterType) {
        const btnId = filterType === 'app' ? '#pm-update-all-global-btn' : '#pm-update-all-col-btn';
        const btn = container ? container.querySelector(btnId) : null;
        return this._applyAvailableUpdates({
            scope: filterType,
            container,
            control: btn ? { el: btn, isSwitch: false } : null,
        });
    }

    /**
     * Apply every update already in the cache. Works with OR without the panel — the
     * command-palette command runs it headless, so nothing here may assume panel DOM exists.
     *
     * @param {{scope?: string, container?: any, control?: any, announceNoop?: boolean}} [opts]
     *   scope        'app' | 'collection' | 'all'
     *   container    panel container, when the panel is open (drives the list re-render)
     *   control      the button to show progress on, when there is one
     *   announceNoop toast when there is nothing to do (a palette command that appears to do
     *                nothing is unacceptable; the panel button is simply hidden in that case)
     *   confirm      ask before overwriting. The panel button does; the palette command does
     *                not — choosing "Update All" from the palette IS the confirmation, and a
     *                modal would defeat the point of it running in the background.
     *   notify       toast each plugin as it lands. With no button to spin, toasts are the only
     *                way a backgrounded run can say what it's doing.
     */
    async _applyAvailableUpdates({ scope = 'all', container = null, control = null, announceNoop = false, confirm = true, notify = false } = {}) {
        // Firing the command twice would run two loops racing on the same update cache.
        if (this._updatingAll) return { count: 0, failed: 0 };

        const upToDate = () => {
            // With a live toast up, the per-plugin check rows are already on screen and settled —
            // finish the SAME toast so the report stays readable instead of tearing it down and
            // landing a fresh one on top of it.
            if (this._progressToast) {
                this._setStatus({ final: true, finalTitle: PM_UP_TO_DATE_TITLE });
                return { count: 0, failed: 0 };
            }
            if (announceNoop) {
                try {
                    this.ui.addToaster({
                        title: PM_UP_TO_DATE_TITLE,
                        message: 'No plugin updates are available.',
                        dismissible: true,
                        autoDestroyTime: 6000,
                    });
                } catch (e) { }
            }
            return { count: 0, failed: 0 };
        };

        // Collect plugins that have known updates
        const availableUpdates = this._readUpdateCache();
        if (Object.keys(availableUpdates).length === 0) return upToDate();

        let pluginsToUpdate = [];
        try {
            if (scope === 'app' || scope === 'all') {
                pluginsToUpdate = pluginsToUpdate.concat(await this.data.getAllGlobalPlugins());
            }
            if (scope === 'collection' || scope === 'all') {
                pluginsToUpdate = pluginsToUpdate.concat(await this.data.getAllCollections());
            }
        } catch (e) { }

        pluginsToUpdate = pluginsToUpdate.filter(p => {
            try {
                return availableUpdates[p.getGuid()];
            } catch (e) { return false; }
        });

        if (pluginsToUpdate.length === 0) return upToDate();

        // Sort so that Plugins Manager (this plugin) updates LAST.
        // Updating self terminates the plugin context immediately.
        pluginsToUpdate.sort((a, b) => {
            if (a.getGuid() === this.getGuid()) return 1;
            if (b.getGuid() === this.getGuid()) return -1;
            return 0;
        });

        if (confirm && !await this._showConfirmModal('Update all', `Apply updates to ${pluginsToUpdate.length} plugin${pluginsToUpdate.length === 1 ? '' : 's'}?\nThis will overwrite any local code modifications for these plugins.`, { confirmText: 'Update all' })) {
            return { count: 0, failed: 0 };
        }

        if (notify) {
            // Same toast, second act: the bar and rows are seeded pending. Rows settle in place
            // as the loop walks them.
            //
            // Both versions are known up front — the installed one from the plugin's own config,
            // the target one from the update cache — so a row that FAILS can still report the
            // version it failed to reach, even if it blew up before the fetch.
            this._setStatus({
                title: 'Updating…',
                verb: 'Updating', verbDone: 'Updated',
                finalTitle: '',
                total: pluginsToUpdate.length,
                done: 0,
                items: pluginsToUpdate.map(p => {
                    let name = 'Unknown';
                    let from = '?';
                    try {
                        const json = p.getExistingCodeAndConfig().json;
                        name = json.name || name;
                        from = json.version || json.ver || '?';
                    } catch (e) { }
                    let to = '?';
                    try { to = (availableUpdates[p.getGuid()] || {}).version || '?'; } catch (e) { }
                    return { name, from, to, state: 'pending' };
                }),
            });
        }

        this._updatingAll = true;
        // No-ops when control is null, so the headless path needs no special casing.
        const busy = this._bulkBusyStart(control && control.el, control && control.isSwitch);

        let successCount = 0;
        let failedNames = [];
        /** @type {string[]} "Name v1.2.2 → v1.2.3" — for the summary toast. */
        const updated = [];
        const total = pluginsToUpdate.length;

        for (let i = 0; i < pluginsToUpdate.length; i++) {
            const p = pluginsToUpdate[i];
            busy.progress(`Updating… (${i + 1}/${total})`);
            if (notify) this._markStatusItem(i, 'active');
            try {
                const conf = p.getExistingCodeAndConfig().json;
                const sourceRepo = conf.__source_repo;
                if (!sourceRepo) continue;

                // Fetch + validate remote, mirroring checkAndUpdatePlugin without its UI prompts
                const { json: remoteJson, js: remoteJs, css: remoteCss } = await this.fetchGithubRepo(sourceRepo, { sourceFiles: conf.__source_files });

                this._validatePluginJS(remoteJson.name, remoteJs);
                const sanitizedConf = this._sanitizePluginConfig(remoteJson);
                if (conf.custom !== undefined) {
                    sanitizedConf.custom = this._cloneJsonValue(conf.custom);
                }
                this._ensurePluginIdentity(sanitizedConf, conf);

                const isSelfUpdate = p.getGuid() === this.getGuid();

                if (remoteCss) {
                    const sanitizedCSS = this._sanitizeCSS(remoteCss);
                    await p.saveCSS(sanitizedCSS);
                }

                if (isSelfUpdate) {
                    // Saving self tears down this plugin's context immediately, so record
                    // success and clear the cache BEFORE the save, then save last.
                    successCount++;
                    if (notify) {
                        this._markStatusItem(i, 'done', {
                            from: conf.version || conf.ver || '?',
                            to: remoteJson.version || remoteJson.ver || '?',
                        });
                    }
                    delete availableUpdates[p.getGuid()];
                    this._writeUpdateCache(availableUpdates);
                    this._updateStatusBarIcon();
                    localStorage.setItem('pm_self_update_pending', 'true');
                    // Only close a panel when OUR panel is the one open. Run from the command
                    // palette with the manager closed, getActivePanel() returns whatever the
                    // user is actually looking at — closing that would shut their note.
                    if (container) {
                        const panel = this.ui.getActivePanel();
                        if (panel) this.ui.closePanel(panel);
                    }
                    await p.savePlugin(sanitizedConf, remoteJs);
                } else {
                    await p.savePlugin(sanitizedConf, remoteJs);
                    // Only mark as updated once the save has actually succeeded.
                    successCount++;
                    delete availableUpdates[p.getGuid()];
                    this._writeUpdateCache(availableUpdates);
                    this._updateStatusBarIcon();
                    if (notify) {
                        // No commit lookup here on purpose: it would cost one extra GitHub API
                        // call per updated plugin against the 60/hr unauthenticated cap that the
                        // update check itself already draws from — i.e. reporting the update
                        // could make the NEXT update check fail. The version delta is the part
                        // that actually matters.
                        const fromV = conf.version || conf.ver || '?';
                        const toV = remoteJson.version || remoteJson.ver || '?';
                        updated.push(`${remoteJson.name || conf.name}  v${fromV} → v${toV}`);

                        // Settles this row in the live toast: traveling dot → ✓ with the version delta.
                        // No new toast, so nothing stacks and nothing is replaced.
                        this._markStatusItem(i, 'done', { from: fromV, to: toV });
                    }
                }
            } catch (e) {
                console.error(e);
                try {
                    const conf = p.getExistingCodeAndConfig().json;
                    failedNames.push(conf.name || 'Unknown');
                } catch (e) { failedNames.push(p.getGuid()); }
                if (notify) this._markStatusItem(i, 'failed');
            }
        }

        this._autoExport(); // fire-and-forget
        busy.end();
        this._updatingAll = false;
        // Only re-render the list when the panel is actually open.
        if (container) this.loadPlugins(container);

        // Summarise exactly what changed, version-to-version, rather than just a count.
        const parts = [];
        if (updated.length > 0) parts.push(updated.join('\n'));
        else parts.push(`Successfully updated: ${successCount}`);
        if (failedNames.length > 0) parts.push(`Failed: ${failedNames.join(', ')}`);

        const title = failedNames.length > 0
            ? "Update All Completed with Errors"
            : PM_UP_TO_DATE_TITLE;

        if (notify) {
            // Headless run: the status toast BECOMES the report. Its headline settles, the bar
            // stays full, every row keeps its mark and version delta, and it waits for OK. Nothing
            // is destroyed and replaced, so the progress you watched is the summary you read.
            this._finishStatus(failedNames.length === 0 ? PM_UP_TO_DATE_TITLE : '');
        } else {
            // Panel path: the list is right there and the button showed progress, so the old
            // auto-dismissing toast is still the right call. Unchanged.
            this.ui.addToaster({
                title,
                message: parts.join('\n'),
                dismissible: true,
                autoDestroyTime: failedNames.length > 0 ? 10000 : 8000
            });
        }

        return { count: successCount, failed: failedNames.length };
    }

    async showExportDialog(typeFilter) {
        const allData = await this._getExportData();
        let candidateData;
        if (typeFilter === 'app') {
            candidateData = allData.filter(d => d.type !== 'collection');
        } else if (typeFilter === 'collection') {
            candidateData = allData.filter(d => d.type === 'collection');
        } else {
            candidateData = allData;
        }

        const sectionMeta = this._getSectionMeta(typeFilter);
        const typeLabel = sectionMeta.label;

        // Build the selection list HTML
        const selectionRows = candidateData.map((d, i) => `
            <label style="display:flex; align-items:center; gap:8px; padding:6px 0; border-bottom:1px solid var(--pm-border-default); cursor:pointer;">
                <input type="checkbox" class="pm-export-cb" data-index="${i}" checked />
                <span style="flex:1; font-size:13px;">${this._escHtml(d.name || 'Unnamed')}</span>
                <span style="font-size:11px; color:var(--pm-text-muted);">${this._escHtml(d.type || '')}</span>
            </label>
        `).join('');

        const overlayHtml = `
            <div id="pm-export-modal" class="pm-modal">
                <div class="pm-modal-content pm-export-content">
                    <h3>Backup ${typeLabel}</h3>

                    <div style="margin-bottom:14px;">
                        <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:6px;">
                            <label style="font-weight:bold; font-size:13px;">Select ${this._escHtml(sectionMeta.itemLabel)} to include</label>
                            <div style="display:flex; gap:8px;">
                                <button class="pm-btn" id="pm-sel-all" style="padding:2px 8px; font-size:11px;">All</button>
                                <button class="pm-btn" id="pm-sel-none" style="padding:2px 8px; font-size:11px;">None</button>
                            </div>
                        </div>
                        <div id="pm-export-selection" style="max-height:180px; overflow-y:auto; border:1px solid var(--pm-border-default); border-radius:6px; padding:0 10px;">
                            ${selectionRows || '<p style="font-size:13px;color:var(--pm-text-muted);padding:8px 0;">No plugins found.</p>'}
                        </div>
                    </div>

                    <div style="margin-bottom: 20px;">
                        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 5px;">
                            <label style="font-weight: bold;">Repository URLs (for quick restore in another workspace)</label>
                            <div style="display: flex; gap: 5px;">
                                <button class="pm-btn" id="pm-copy-urls" style="padding: 2px 8px; font-size: 11px;">Copy URLs</button>
                                <button class="pm-btn" id="pm-download-urls" style="padding: 2px 8px; font-size: 11px;">Download URLs</button>
                            </div>
                        </div>
                        <textarea class="pm-textarea pm-textarea-urls" id="pm-urls-text" readonly></textarea>
                    </div>
                    
                    <div style="margin-bottom: 15px;">
                        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 5px;">
                            <label style="font-weight: bold;">Full Backup (JSON with code, CSS, config, and manager settings)</label>
                            <div style="display: flex; gap: 5px;">
                                <button class="pm-btn" id="pm-copy-json" style="padding: 2px 8px; font-size: 11px;">Copy JSON</button>
                                <button class="pm-btn primary" id="pm-download-json" style="padding: 2px 8px; font-size: 11px;">Download Backup</button>
                            </div>
                        </div>
                        <textarea class="pm-textarea pm-textarea-json" id="pm-full-backup-text" readonly></textarea>
                    </div>
                    
                    <div style="display: flex; justify-content: flex-end; gap: 10px; margin-top: 20px;">
                        <button class="pm-btn" id="pm-export-close">Close</button>
                    </div>
                </div>
            </div>
        `;

        const tempDiv = document.createElement('div');
        tempDiv.innerHTML = overlayHtml;
        this._openModal(tempDiv);

        // Helper: compute selected export data and refresh the textareas
        const refreshTextareas = () => {
            const checked = [...tempDiv.querySelectorAll('.pm-export-cb:checked')].map(cb => candidateData[parseInt(cb.dataset.index)]);
            const urls = checked.map(d => d.source_repo).filter(Boolean).join('\n');
            const fullBackup = JSON.stringify(this._buildExportPayload(typeFilter, checked), null, 2);
            tempDiv.querySelector('#pm-urls-text').value = urls;
            tempDiv.querySelector('#pm-full-backup-text').value = fullBackup;
        };

        // Initial fill
        refreshTextareas();

        // Checkbox changes
        tempDiv.querySelectorAll('.pm-export-cb').forEach(cb => cb.addEventListener('change', refreshTextareas));

        // Select All / None
        tempDiv.querySelector('#pm-sel-all').addEventListener('click', () => {
            tempDiv.querySelectorAll('.pm-export-cb').forEach(cb => cb.checked = true);
            refreshTextareas();
        });
        tempDiv.querySelector('#pm-sel-none').addEventListener('click', () => {
            tempDiv.querySelectorAll('.pm-export-cb').forEach(cb => cb.checked = false);
            refreshTextareas();
        });

        tempDiv.querySelector('#pm-export-close').addEventListener('click', () => {
            this._closeModal(tempDiv);
        });

        // Copy actions
        tempDiv.querySelector('#pm-copy-urls').addEventListener('click', async (e) => {
            await navigator.clipboard.writeText(tempDiv.querySelector('#pm-urls-text').value);
            const orig = e.target.innerText;
            e.target.innerText = "Copied!";
            setTimeout(() => e.target.innerText = orig, 2000);
        });

        tempDiv.querySelector('#pm-copy-json').addEventListener('click', async (e) => {
            await navigator.clipboard.writeText(tempDiv.querySelector('#pm-full-backup-text').value);
            const orig = e.target.innerText;
            e.target.innerText = "Copied!";
            setTimeout(() => e.target.innerText = orig, 2000);
        });

        // Download actions
        tempDiv.querySelector('#pm-download-urls').addEventListener('click', () => {
            const content = tempDiv.querySelector('#pm-urls-text').value;
            const blob = new Blob([content], { type: 'text/plain' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `thymer-${typeFilter}-urls-${this._getWorkspaceName()}.txt`;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
        });

        tempDiv.querySelector('#pm-download-json').addEventListener('click', () => {
            const content = tempDiv.querySelector('#pm-full-backup-text').value;
            const blob = new Blob([content], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = this._getBackupJsonFilename(typeFilter);
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
        });
    }

    async showImportDialog(container, typeFilter) {
        const sectionMeta = this._getSectionMeta(typeFilter);
        const overlayHtml = `
            <div id="pm-import-modal" class="pm-modal">
                <div class="pm-modal-content">
                    <h3>Restore ${sectionMeta.importLabel}</h3>
                    <p>Paste GitHub URLs (one per line), paste a JSON backup array/object, or upload a workspace backup file.</p>
                    <textarea id="pm-import-textarea" class="pm-textarea" placeholder="https://github.com/user/repo1\nhttps://github.com/user/repo2"></textarea>
                    
                    <div style="margin-top: 10px; padding-top: 10px; border-top: 1px solid var(--pm-border-default);">
                        <label style="display: block; font-size: 13px; margin-bottom: 5px; color: var(--pm-text-muted);">Or upload a backup file:</label>
                        <input type="file" id="pm-import-file" accept=".json" style="font-size: 13px; color: inherit; width: 100%;" />
                    </div>

                    <div style="margin-top: 15px; display: flex; align-items: center; justify-content: space-between;">
                        <label style="display: flex; align-items: center; gap: 8px; font-size: 13px; cursor: pointer;">
                            <input type="checkbox" id="pm-import-full-override" />
                            <span style="color: var(--pm-danger-fg, var(--pm-danger)); font-weight: bold;">Full Override (Delete existing)</span>
                        </label>
                        <div style="display: flex; gap: 10px;">
                            <button class="pm-btn" id="pm-import-cancel">Cancel</button>
                            <button class="pm-btn primary" id="pm-import-confirm">Import</button>
                        </div>
                    </div>
                </div>
            </div>
        `;

        const tempDiv = document.createElement('div');
        tempDiv.innerHTML = overlayHtml;
        this._openModal(tempDiv);

        document.getElementById('pm-import-cancel').addEventListener('click', () => {
            this._closeModal(tempDiv);
        });

        // Handle file upload immediately dumping text into the textarea for preview/processing
        document.getElementById('pm-import-file').addEventListener('change', (e) => {
            const file = e.target.files[0];
            if (!file) return;
            const reader = new FileReader();
            reader.onload = (ev) => {
                document.getElementById('pm-import-textarea').value = ev.target.result;
            };
            reader.readAsText(file);
        });

        document.getElementById('pm-import-confirm').addEventListener('click', async () => {
            const val = document.getElementById('pm-import-textarea').value.trim();
            if (!val) return;

            const isFullOverride = document.getElementById('pm-import-full-override').checked;
            if (isFullOverride) {
                if (!await this._showConfirmModal('Full override', `Full Override will DELETE existing ${sectionMeta.warningLabel} that are not in this backup.\nThis cannot be undone. Are you sure?`, { confirmText: 'Override', danger: true })) {
                    return;
                }
            }

            document.getElementById('pm-import-confirm').innerText = "Restoring...";
            document.getElementById('pm-import-confirm').disabled = true;

            let successCount = 0;
            let failedNames = [];
            let skippedNames = [];
            let deletedCount = 0;

            if (val.startsWith('[') || val.startsWith('{')) {
                // JSON full backup import
                try {
                    const parsed = JSON.parse(val);
                    const { items: importedItems, managerSettings } = this._normalizeImportedBackup(parsed, typeFilter);

                    if (isFullOverride) {
                        const backupNames = importedItems.map(p => (p.json && p.json.name) || p.name).filter(Boolean);

                        if (typeFilter === 'app' || typeFilter === 'all') {
                            const allGlobals = await this.data.getAllGlobalPlugins();
                            for (const p of allGlobals) {
                                try {
                                    const pName = p.getExistingCodeAndConfig().json.name;
                                    if (!backupNames.includes(pName) && pName.toLowerCase() !== 'plugins manager') {
                                        await p.trashPlugin();
                                        deletedCount++;
                                    }
                                } catch (e) { }
                            }
                        }

                        if (typeFilter === 'collection' || typeFilter === 'all') {
                            const allCollections = await this.data.getAllCollections();
                            for (const c of allCollections) {
                                try {
                                    const cName = c.getExistingCodeAndConfig().json.name;
                                    if (!backupNames.includes(cName)) {
                                        await c.trashPlugin();
                                        deletedCount++;
                                    }
                                } catch (e) { }
                            }
                        }
                    }

                    for (const p of importedItems) {
                        // Merge wrapper-level type into json conf (export format puts type on wrapper, not inside json)
                        const mergedJson = { ...p.json };
                        if (!mergedJson.type && p.type) mergedJson.type = p.type;
                        const pName = mergedJson.name || p.name || 'Unknown';
                        try {
                            const result = await this.installPlugin(mergedJson, p.code, { interactive: !isFullOverride, cssCode: p.css, trustedConfig: true });
                            if (result === 'skipped') { skippedNames.push(pName); }
                            else { successCount++; }
                        } catch (e) {
                            console.error(e);
                            failedNames.push(pName);
                        }
                    }

                    await this._restoreImportedManagerSettings(managerSettings, container);
                } catch (e) {
                    this.ui.addToaster({ title: "Import Failed", message: e.message || "Invalid JSON format", autoDestroyTime: 5000, dismissible: true });
                    this._closeModal(tempDiv);
                    return;
                }
            } else {
                // URLs import
                const urls = val.split('\n').map(u => u.trim()).filter(Boolean);
                for (const url of urls) {
                    const shortUrl = url.replace(/https?:\/\/github\.com\//, '');
                    try {
                        const { json, js, css } = await this.fetchGithubRepo(url);
                        const pName = json.name || shortUrl;
                        const result = await this.installPlugin(json, js, { interactive: !isFullOverride, cssCode: css });
                        if (result === 'skipped') { skippedNames.push(pName); }
                        else { successCount++; }
                    } catch (e) {
                        console.error(e);
                        failedNames.push(shortUrl);
                    }
                }
            }

            this._closeModal(tempDiv);
            const parts = [`Installed: ${successCount}`];
            if (deletedCount > 0) parts.push(`Deleted: ${deletedCount}`);
            if (skippedNames.length > 0) parts.push(`Skipped: ${skippedNames.join(', ')}`);
            if (failedNames.length > 0) parts.push(`Failed: ${failedNames.join(', ')}`);
            this.ui.addToaster({
                title: "Restore Complete",
                message: parts.join('. '),
                dismissible: true,
                autoDestroyTime: failedNames.length > 0 ? 8000 : 5000
            });
            this.loadPlugins(container);
            this._renderWorkspaceSummary(container);
        });
    }

    async checkAndUpdatePlugin(pluginObj, currentConf, sourceRepo, btnEl, container, knownUpdateVersion = null, options = {}) {
        const forceUpdate = options.forceUpdate === true;
        try {
            btnEl.innerHTML = '';
            btnEl.appendChild(this.ui.createIcon('loader'));
            btnEl.disabled = true;

            let remoteJson, remoteJs, remoteCss;
            try {
                const res = await this.fetchGithubRepo(sourceRepo, { sourceFiles: currentConf.__source_files });
                remoteJson = res.json;
                remoteJs = res.js;
                remoteCss = res.css;
            } catch (fetchErr) {
                throw new Error(`Failed to fetch from ${sourceRepo}: ${fetchErr.message}`);
            }

            if (!forceUpdate && remoteJson.version === currentConf.version) {
                this.ui.addToaster({ title: "Up to date", message: `${currentConf.name} is already on the latest version.`, autoDestroyTime: 3000, dismissible: true });
                btnEl.className = 'pm-btn pm-btn-update';
                btnEl.innerHTML = '';
                btnEl.appendChild(this.ui.createIcon('check'));

                // Clear from known updates
                try {
                    const available = this._readUpdateCache();
                    delete available[pluginObj.getGuid()];
                    this._writeUpdateCache(available);
                    this._updateStatusBarIcon();
                } catch (e) { }

                const badge = document.getElementById(`vbadge-${pluginObj.getGuid()}`);
                if (badge) {
                    badge.innerText = `v${currentConf.version}`;
                    badge.classList.remove('update');
                }

                setTimeout(() => {
                    btnEl.innerHTML = '';
                    btnEl.appendChild(this.ui.createIcon('refresh'));
                    btnEl.title = 'Check Update';
                    btnEl.disabled = false;
                }, 3000);
                return true;
            }

            // Update available or forceUpdate requested
            const pGuid = pluginObj.getGuid();
            const badge = document.getElementById(`vbadge-${pGuid}`);
            if (badge) {
                badge.innerText = `Update Available (v${remoteJson.version})`;
                badge.classList.add('update');
            }

            btnEl.innerHTML = '';
            btnEl.appendChild(this.ui.createIcon('arrow-up'));
            btnEl.className = 'pm-btn pm-btn-update update-btn';
            btnEl.disabled = false;

            // Update local storage so indicator persists
            try {
                const available = this._readUpdateCache();
                available[pluginObj.getGuid()] = { name: currentConf.name || remoteJson.name || '', version: remoteJson.version };
                this._writeUpdateCache(available);
                this._updateStatusBarIcon();
            } catch (e) { }

            // Overwrite click handler to apply update
            const applyUpdate = async () => {
                // Local modifications warning check (simple length/hash comparison could go here in future)
                if (await this._showConfirmModal('Update plugin', `Update ${currentConf.name} from v${currentConf.version} to v${remoteJson.version}?\nThis will overwrite any local code modifications.`, { confirmText: 'Update' })) {
                    this._validatePluginJS(remoteJson.name, remoteJs);
                    const sanitizedConf = this._sanitizePluginConfig(remoteJson);
                    if (currentConf.custom !== undefined) {
                        sanitizedConf.custom = this._cloneJsonValue(currentConf.custom);
                    }
                    this._ensurePluginIdentity(sanitizedConf, currentConf);

                    const isSelfUpdate = pluginObj.getGuid() === this.getGuid();

                    if (remoteCss) {
                        const sanitizedCSS = this._sanitizeCSS(remoteCss);
                        await pluginObj.saveCSS(sanitizedCSS);
                    }

                    // Remove from updates cache
                    try {
                        const available = this._readUpdateCache();
                        delete available[pGuid];
                        this._writeUpdateCache(available);
                        this._updateStatusBarIcon();
                    } catch (e) { }

                    if (isSelfUpdate) {
                        const panel = this.ui.getActivePanel();
                        if (panel) this.ui.closePanel(panel);
                        localStorage.setItem('pm_self_update_pending', 'true');
                    } else {
                        this._autoExport(); // fire-and-forget
                        this.ui.addToaster({ title: "Update Successful", message: `${currentConf.name} updated to v${remoteJson.version}`, autoDestroyTime: 3000, dismissible: true });
                    }

                    await pluginObj.savePlugin(sanitizedConf, remoteJs);

                    if (!isSelfUpdate) {
                        this.loadPlugins(container);
                    }
                }
                return false;
            };

            // If we already knew about this update, the click intent was to apply it, not just check
            if (knownUpdateVersion) {
                return await applyUpdate();
            } else {
                btnEl.onclick = applyUpdate;
                return true;
            }

        } catch (err) {
            console.error(err);
            this.ui.addToaster({ title: "Update Failed", message: err.message, autoDestroyTime: 5000, dismissible: true });
            btnEl.innerHTML = '';
            btnEl.appendChild(this.ui.createIcon('refresh'));
            btnEl.title = 'Check Update';
            btnEl.disabled = false;
            return false;
        }
    }
}
