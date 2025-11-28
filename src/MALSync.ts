/// <reference path="./plugin.d.ts" />
/// <reference path="./system.d.ts" />
/// <reference path="./app.d.ts" />
/// <reference path="./core.d.ts" />

// @ts-ignore
function init() {
	$ui.register(async (ctx) => {
		// --- CONSTANTS ---
		const ICON_URL = "https://cdn.myanimelist.net/images/favicon.ico";
		const BASE_URI_V2 = "https://api.myanimelist.net/v2";
		const REDIRECT_URI = "http://localhost"; 

		// --- STATE MANAGEMENT ---
		const currentPage = ctx.state<"status" | "logs" | "settings" | "raw">("status");
		const logs = ctx.state<{ time: string; msg: string; type: "info" | "success" | "error" | "warn" }[]>([]);
		const statusText = ctx.state<string>("Idle");
		const statusIntent = ctx.state<"info" | "success" | "warning" | "alert">("info");
		const isAuthenticated = ctx.state<boolean>(false);
		const configSavedTrigger = ctx.state<number>(0);
		const settingsFeedback = ctx.state<string>("");

		// Sync State
		const isSyncing = ctx.state<boolean>(false);
		const shouldStop = ctx.state<boolean>(false); 
		const syncProgress = ctx.state<number>(0); 
		const syncMessage = ctx.state<string>("");
		
		// Session Memory
		const recentlySynced = ctx.state<number[]>([]);

		// Raw Data Output State
		const rawDataOutput = ctx.state<string>("Waiting for updates... (Only changes will appear here)");

		// --- SETTINGS FIELDS ---
		const clientIdRef = ctx.fieldRef<string>($storage.get("malsync.clientId") || "");
		const clientSecretRef = ctx.fieldRef<string>($storage.get("malsync.clientSecret") || "");
		const authCodeRef = ctx.fieldRef<string>($storage.get("malsync.authCode") || "");
		
		// Preferences
		const liveSyncRef = ctx.fieldRef<boolean>($storage.get("malsync.liveSync") ?? true);
		const syncOnStartupRef = ctx.fieldRef<boolean>($storage.get("malsync.syncOnStartup") ?? false);
		const syncEvery24hRef = ctx.fieldRef<boolean>($storage.get("malsync.syncEvery24h") ?? false);
		const syncDeletionsRef = ctx.fieldRef<boolean>($storage.get("malsync.syncDeletions") ?? false);
		const syncRemovalsSafeRef = ctx.fieldRef<boolean>($storage.get("malsync.syncRemovalsSafe") ?? false);
		
		// NEW: Sync Direction
		// "ANI_TO_MAL" or "MAL_TO_ANI"
		const syncModeRef = ctx.fieldRef<string>($storage.get("malsync.syncMode") || "ANI_TO_MAL");

		// --- HELPERS ---
		function generateCodeVerifier() {
			const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~';
			let result = '';
			for (let i = 0; i < 128; i++) {
				result += chars.charAt(Math.floor(Math.random() * chars.length));
			}
			return result;
		}

		function addLog(msg: string, type: "info" | "success" | "error" | "warn" = "info") {
			const now = new Date();
			const timeString = `${now.getHours().toString().padStart(2, "0")}:${now.getMinutes().toString().padStart(2, "0")}:${now.getSeconds().toString().padStart(2, "0")}`;
			
			const currentLogs = logs.get();
			const newLogs = [{ time: timeString, msg, type }, ...currentLogs].slice(0, 1000); 
			logs.set(newLogs);
			
			if (!isSyncing.get()) {
				if (type === "error") {
					statusText.set("Error detected");
					statusIntent.set("alert");
				} else if (type === "success") {
					statusText.set("Sync active");
					statusIntent.set("success");
				}
			}
		}

		function appendRawLog(title: string, action: string, malData: any, aniData: any, payload: any) {
			const entry = `
==================================================
ACTION: ${action} | ANIME: ${title}
--------------------------------------------------
[MAL]: ${JSON.stringify(malData || "null")}
[ANILIST]: ${JSON.stringify(aniData)}
[PAYLOAD]: ${JSON.stringify(payload, null, 2)}
==================================================
`;
			const current = rawDataOutput.get();
			const truncated = current.length > 50000 ? current.substring(0, 50000) + "\n...[Old logs truncated]" : current;
			rawDataOutput.set(entry + "\n" + truncated);
		}

		function $_wait(ms: number): Promise<void> {
			return new Promise((resolve) => ctx.setTimeout(resolve, ms));
		}

		function normalizeStatusToMal(statusAL: string): string | null {
			const map: Record<string, string> = {
				"COMPLETED": "completed",
				"CURRENT": "watching",
				"DROPPED": "dropped",
				"PAUSED": "on_hold",
				"PLANNING": "plan_to_watch",
				"REPEATING": "watching",
			};
			return map[statusAL] || null;
		}

		function normalizeStatusToAni(statusMAL: string): $app.AL_MediaListStatus | null {
			const map: Record<string, $app.AL_MediaListStatus> = {
				"completed": "COMPLETED",
				"watching": "CURRENT",
				"dropped": "DROPPED",
				"on_hold": "PAUSED",
				"plan_to_watch": "PLANNING",
			};
			return map[statusMAL] || null;
		}

		// --- TOKEN MANAGER ---
		const tokenManager = {
			token: {
				accessToken: ($storage.get("malsync.accessToken") as string | undefined) ?? null,
				refreshToken: ($storage.get("malsync.refreshToken") as string | undefined) ?? null,
				expiresAt: ($storage.get("malsync.expiresAt") as number | undefined) ?? null,
			},
			baseAuthUri: "https://myanimelist.net/v1/oauth2/token",

			getCredentials() {
				const cid = $storage.get("malsync.clientId") as string;
				const csec = $storage.get("malsync.clientSecret") as string;
				if (!cid || !csec) throw new Error("Missing Client ID or Secret");
				return { cid, csec };
			},

			getAccessToken() {
				if (!this.token.accessToken || !this.token.refreshToken || !this.token.expiresAt) return null;
				if (Date.now() > this.token.expiresAt) return null;
				return this.token.accessToken;
			},

			async exchangeCode(code: string) {
				const { cid, csec } = this.getCredentials();
				const codeVerifier = $storage.get("malsync.pkceVerifier") as string;
				if (!codeVerifier) throw new Error("Missing PKCE Verifier. Please click 'Get Code' again.");

				addLog("Exchanging auth code...", "info");
				
				const res = await ctx.fetch(this.baseAuthUri, {
					method: "POST",
					headers: { "Content-Type": "application/x-www-form-urlencoded" },
					body: new URLSearchParams({
						grant_type: "authorization_code",
						client_id: cid,
						client_secret: csec,
						code: code,
						code_verifier: codeVerifier,
						redirect_uri: REDIRECT_URI,
					}),
				});

				if (!res.ok) throw new Error(`Auth failed: ${res.statusText}`);
				this.saveToken(await res.json());
				addLog("Authentication successful", "success");
			},

			async refresh() {
				const { cid, csec } = this.getCredentials();
				if (!this.token.refreshToken) throw new Error("No refresh token");

				addLog("Refreshing token...", "info");
				const res = await ctx.fetch(this.baseAuthUri, {
					method: "POST",
					headers: { "Content-Type": "application/x-www-form-urlencoded" },
					body: new URLSearchParams({
						grant_type: "refresh_token",
						client_id: cid,
						client_secret: csec,
						refresh_token: this.token.refreshToken,
					}),
				});

				if (!res.ok) throw new Error(`Refresh failed: ${res.statusText}`);
				this.saveToken(await res.json());
				addLog("Token refreshed", "success");
			},

			saveToken(data: any) {
				const expiresAt = Date.now() + data.expires_in * 1000;
				$storage.set("malsync.accessToken", data.access_token);
				$storage.set("malsync.refreshToken", data.refresh_token);
				$storage.set("malsync.expiresAt", expiresAt);

				this.token = {
					accessToken: data.access_token,
					refreshToken: data.refresh_token,
					expiresAt: expiresAt,
				};
				isAuthenticated.set(true);
				statusText.set("Authenticated");
				statusIntent.set("success");
			},

			async withAuthHeaders(): Promise<Record<string, string>> {
				if (!this.getAccessToken()) await this.refresh();
				return {
					Authorization: `Bearer ${this.token!.accessToken}`,
					"Content-Type": "application/x-www-form-urlencoded", 
				};
			},
		};

		// --- MAL API METHODS ---

		async function updateMalEntry(idMal: number, data: Record<string, any>) {
			const body = new URLSearchParams();
			for (const key in data) {
				const val = data[key];
				if(val !== null && val !== undefined) {
					body.append(key, val.toString());
				}
			}

			let lastError;
			for (let i = 0; i < 3; i++) {
				try {
					const res = await ctx.fetch(`${BASE_URI_V2}/anime/${idMal}/my_list_status`, {
						method: "PUT",
						headers: await tokenManager.withAuthHeaders(),
						body: body,
					});
					
					if (!res.ok) throw new Error(`Status ${res.status} ${res.statusText}`);
					return await res.json();
				} catch (e) {
					lastError = e;
					await $_wait(2000); 
				}
			}
			throw lastError; 
		}

		async function deleteMalEntry(idMal: number) {
			const res = await ctx.fetch(`${BASE_URI_V2}/anime/${idMal}/my_list_status`, {
				method: "DELETE",
				headers: await tokenManager.withAuthHeaders(),
			});
			if (!res.ok && res.status !== 404) throw new Error(`Delete failed: ${res.statusText}`);
		}

		async function fetchFullMalList() {
			let allEntries: any[] = [];
			const fieldsParam = "fields=list_status{status,score,num_episodes_watched,is_rewatching,num_times_rewatched}";
			const LIMIT = 500;
			let offset = 0;
			let hasMore = true;

			while (hasMore) {
				const url = `${BASE_URI_V2}/users/@me/animelist?limit=${LIMIT}&offset=${offset}&${fieldsParam}&nsfw=true`;

				let res;
				try {
					res = await ctx.fetch(url, { headers: await tokenManager.withAuthHeaders() });
				} catch(e) {
					await $_wait(1000);
					res = await ctx.fetch(url, { headers: await tokenManager.withAuthHeaders() });
				}

				if (!res.ok) throw new Error(`Failed to fetch MAL list: ${res.statusText}`);
				
				const data = await res.json();
				const pageItems = data.data || [];
				
				if (pageItems.length === 0) {
					hasMore = false;
				} else {
					allEntries = allEntries.concat(pageItems);
					
					if (pageItems.length < LIMIT) {
						hasMore = false;
					} else {
						offset += LIMIT;
						await $_wait(300);
					}
				}
			}
			return allEntries;
		}

		// --- ANILIST HELPERS ---
		async function getAniListIdByMalId(malId: number): Promise<number | null> {
			try {
				// Custom GraphQL Query to find Media by idMal
				const query = `query($id: Int) { Media(idMal: $id, type: ANIME) { id } }`;
				const data = await $anilist.customQuery(query, { id: malId });
				if (data && data.data && data.data.Media && data.data.Media.id) {
					return data.data.Media.id;
				}
				return null;
			} catch(e) {
				return null;
			}
		}

		// --- EVENT HANDLERS ---

		ctx.registerEventHandler("nav-status", () => currentPage.set("status"));
		ctx.registerEventHandler("nav-logs", () => currentPage.set("logs"));
		ctx.registerEventHandler("nav-settings", () => currentPage.set("settings"));
		ctx.registerEventHandler("nav-raw", () => currentPage.set("raw"));

		ctx.registerEventHandler("save-config", () => {
			$storage.set("malsync.clientId", clientIdRef.current);
			$storage.set("malsync.clientSecret", clientSecretRef.current);
			addLog("Configuration saved", "success");
			settingsFeedback.set("✅ Saved! Please click 'Get Auth Code' below.");
			const verifier = generateCodeVerifier();
			$storage.set("malsync.pkceVerifier", verifier);
			configSavedTrigger.set(Date.now());
		});
		
		ctx.registerEventHandler("save-prefs", () => {
			$storage.set("malsync.liveSync", liveSyncRef.current);
			$storage.set("malsync.syncOnStartup", syncOnStartupRef.current);
			$storage.set("malsync.syncEvery24h", syncEvery24hRef.current);
			$storage.set("malsync.syncDeletions", syncDeletionsRef.current);
			$storage.set("malsync.syncRemovalsSafe", syncRemovalsSafeRef.current);
			$storage.set("malsync.syncMode", syncModeRef.current); // Save Mode
			addLog("Preferences saved", "success");
			settingsFeedback.set("✅ Preferences Saved!");
		});

		ctx.registerEventHandler("connect-auth", async () => {
			let input = authCodeRef.current.trim();
			if (input.startsWith("http")) {
				const match = input.match(/[?&]code=([^&]+)/);
				if (match && match[1]) {
					input = match[1];
					authCodeRef.setValue(input);
					addLog("Extracted code from URL", "info");
				}
			}
			$storage.set("malsync.authCode", input);
			if (input) {
				try {
					await tokenManager.exchangeCode(input);
					settingsFeedback.set("✅ Connected Successfully!");
				} catch (e) {
					addLog(`Connection failed: ${(e as Error).message}`, "error");
					settingsFeedback.set("❌ Connection Failed. Check Logs.");
				}
			} else {
				addLog("Please enter the Auth Code", "warn");
				settingsFeedback.set("⚠️ Please paste the Auth Code first.");
			}
		});

		ctx.registerEventHandler("clear-logs", () => {
			logs.set([]);
			addLog("Logs cleared", "info");
		});

		ctx.registerEventHandler("clear-raw", () => {
			rawDataOutput.set("Cleared. Waiting for updates...");
		});

		ctx.registerEventHandler("stop-sync", () => {
			shouldStop.set(true);
			addLog("Stopping sync...", "warn");
		});

		ctx.registerEventHandler("run-sync-ani-to-mal", () => executeFullSync("ANI_TO_MAL"));
		ctx.registerEventHandler("run-sync-mal-to-ani", () => executeFullSync("MAL_TO_ANI"));


		// --- INITIALIZATION ---

		if (tokenManager.getAccessToken()) {
			isAuthenticated.set(true);
			statusText.set("Authenticated");
			statusIntent.set("success");

			// AUTOMATION LOGIC
			const mode = $storage.get("malsync.syncMode") || "ANI_TO_MAL";

			// Sync on Startup
			if ($storage.get("malsync.syncOnStartup") === true) {
				addLog(`Queuing Startup Sync (${mode})...`, "info");
				ctx.setTimeout(() => executeFullSync(mode), 5000);
			}

			// Sync every 24h
			if ($storage.get("malsync.syncEvery24h") === true) {
				addLog(`Daily Sync Schedule Enabled (${mode})`, "info");
				ctx.setInterval(() => {
					executeFullSync(mode);
				}, 86400000); // 24 hours
			}

		} else {
			statusText.set("Configuration needed");
			statusIntent.set("warning");
		}

		// --- UI RENDERING ---

		const tray = ctx.newTray({ iconUrl: ICON_URL, withContent: true, width: "fit-content" });

		tray.render(() => {
			const page = currentPage.get();
			const _renderTrigger = configSavedTrigger.get(); 
			const feedback = settingsFeedback.get();

			const navBar = tray.flex([
				tray.button({ label: "Status", onClick: "nav-status", size: "sm", intent: page === "status" ? "primary" : "gray-subtle" }),
				tray.button({ label: "Logs", onClick: "nav-logs", size: "sm", intent: page === "logs" ? "primary" : "gray-subtle" }),
				tray.button({ label: "Settings", onClick: "nav-settings", size: "sm", intent: page === "settings" ? "primary" : "gray-subtle" }),
				tray.button({ label: "Raw Data", onClick: "nav-raw", size: "sm", intent: page === "raw" ? "primary" : "gray-subtle" }),
			], { gap: 1, style: { marginBottom: "10px", justifyContent: "center" } });

			// PAGE: STATUS
			if (page === "status") {
				const syncing = isSyncing.get();
				const progress = syncProgress.get();
				const barBackground = `linear-gradient(90deg, #3498db ${progress}%, #222 ${progress}%)`;

				return tray.stack([
					navBar,
					tray.div([
						tray.text("MyAnimeList Sync", { style: { fontWeight: "bold", fontSize: "16px", textAlign: "center" } }),
						tray.text(`Status: ${statusText.get()}`, { 
							style: { 
								color: statusIntent.get() === "success" ? "#4caf50" : statusIntent.get() === "alert" ? "#f44336" : "#ff9800",
								textAlign: "center"
							} 
						}),
					], { style: { padding: "10px", alignItems: "center" } }),

					syncing ? tray.stack([
						tray.text(syncMessage.get(), { style: { fontSize: "12px", textAlign: "center", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", maxWidth: "280px" } }),
						// PROGRESS BAR
						tray.div([], { 
							style: { 
								width: "100%", 
								height: "16px", 
								background: barBackground, 
								border: "1px solid #555",
								borderRadius: "4px",
								marginTop: "10px",
								marginBottom: "15px"
							} 
						}),
						tray.button({ label: "Stop Sync", onClick: "stop-sync", intent: "alert", size: "sm" })
					], { gap: 1, style: { width: "100%" } }) 
					: isAuthenticated.get() ? tray.stack([
						// TWO BUTTONS
						tray.button({ label: "Sync (AniList ➜ MAL)", onClick: "run-sync-ani-to-mal", intent: "primary" }),
						tray.button({ label: "Import (MAL ➜ AniList)", onClick: "run-sync-mal-to-ani", intent: "gray-subtle" }),
					], { gap: 1, style: { marginTop: "5px" } })
					: tray.text(""), 

					isAuthenticated.get() 
						? tray.text("Auto-sync is running in the background.", { style: { opacity: "0.7", fontSize: "11px", textAlign: "center" } })
						: tray.text("Please go to Settings to configure the plugin.", { style: { opacity: "0.7", fontSize: "12px", textAlign: "center", color: "#f44336" } })
				], { gap: 2, style: { minWidth: "250px" } });
			}

			// PAGE: LOGS
			if (page === "logs") {
				const logItems = logs.get();
				return tray.stack([
					navBar,
					tray.flex([
						tray.text("Activity Log", { style: { fontWeight: "bold" } }),
						tray.button({ label: "Clear", onClick: "clear-logs", size: "sm", intent: "gray-subtle" })
					], { justifyContent: "space-between", alignItems: "center" }),
					
					tray.stack(
						logItems.length === 0 
						? [tray.text("No activity yet.", { style: { opacity: "0.5", fontStyle: "italic" } })]
						: logItems.map(l => {
							let color = "inherit";
							if (l.type === "error") color = "#f44336";
							if (l.type === "success") color = "#4caf50";
							if (l.type === "warn") color = "#ff9800";
							return tray.text(`[${l.time}] ${l.msg}`, { style: { color, fontSize: "12px" } });
						}), 
						{ gap: 1, style: { maxHeight: "200px", overflowY: "auto", border: "1px solid #333", padding: "5px", borderRadius: "4px" } }
					)
				], { gap: 2 });
			}

			// PAGE: SETTINGS
			if (page === "settings") {
				const savedClientId = $storage.get("malsync.clientId");
				const savedVerifier = $storage.get("malsync.pkceVerifier");
				const hasConfig = !!savedClientId && !!savedVerifier;
				const feedback = settingsFeedback.get();

				return tray.stack([
					navBar,
					
					// 1. Preferences (Top)
					tray.text("Preferences", { style: { fontWeight: "bold" } }),
					tray.checkbox({ fieldRef: liveSyncRef, label: "Live Sync (Sync changes instantly)" }),
					tray.checkbox({ fieldRef: syncOnStartupRef, label: "Full Sync on Startup" }),
					tray.checkbox({ fieldRef: syncEvery24hRef, label: "Full Sync Every 24h" }),
					
					// SYNC MODE DROPDOWN
					tray.select({
						label: "Auto-Sync Mode (Direction)",
						fieldRef: syncModeRef,
						options: [
							{ label: "AniList ➜ MAL (Default)", value: "ANI_TO_MAL" },
							{ label: "MAL ➜ AniList (Import)", value: "MAL_TO_ANI" }
						]
					}),

					tray.div([], { style: { height: "1px", background: "#444", margin: "5px 0" } }),
					tray.checkbox({ fieldRef: syncRemovalsSafeRef, label: "Track Removals (Safe Mode)" }),
					tray.checkbox({ fieldRef: syncDeletionsRef, label: "Sync Deletions (Danger!)" }),

					tray.button({ label: "Save Preferences", onClick: "save-prefs", intent: "primary", size: "sm" }),
					
					tray.div([], { style: { height: "1px", background: "#444", margin: "10px 0" } }),

					// 2. Connection Setup (Bottom)
					tray.text("Connection Setup", { style: { fontWeight: "bold" } }),
					
					tray.flex([
						tray.text("1. Create App at ", { style: { fontSize: "11px" } }),
						tray.anchor({ 
							text: "myanimelist.net/apiconfig", 
							href: "https://myanimelist.net/apiconfig",
							target: "_blank",
							style: { fontSize: "11px", color: "#3498db" }
						})
					], { gap: 1, style: { alignItems: "baseline" } }),

					tray.stack([
						tray.text("• App Type: Web", { style: { fontSize: "11px", marginLeft: "10px", color: "#aaa" } }),
						tray.text("• App Redirect URL: http://localhost", { style: { fontSize: "11px", marginLeft: "10px", color: "#aaa" } }),
					], { gap: 0 }),

					tray.input({ fieldRef: clientIdRef, placeholder: "Client ID", label: "Client ID" }),
					tray.input({ fieldRef: clientSecretRef, placeholder: "Client Secret", label: "Client Secret" }),
					
					tray.button({ label: "Save Keys (Generates Link)", onClick: "save-config", intent: "gray-subtle", size: "sm" }),
					
					feedback ? tray.text(feedback, { style: { fontSize: "12px", color: feedback.includes("✅") ? "#4caf50" : "#f44336", fontWeight: "bold" } }) : tray.text(""),

					hasConfig ? tray.stack([
						tray.anchor({ 
							text: "Get Auth Code", 
							href: `https://myanimelist.net/v1/oauth2/authorize?response_type=code&client_id=${savedClientId}&code_challenge=${savedVerifier}&redirect_uri=${encodeURIComponent(REDIRECT_URI)}`,
							target: "_blank",
							style: { fontSize: "14px", fontWeight: "bold", color: "#3498db" }
						}),
						tray.text("Note: After allowing access, copy the FULL URL from the browser and paste it below.", { style: { fontSize: "11px", opacity: "0.7", fontStyle: "italic" } }),
					], { gap: 1 }) : tray.text(""),

					tray.input({ fieldRef: authCodeRef, placeholder: "Paste Code or Full URL here", label: "Auth Code" }),
					tray.button({ label: "Connect", onClick: "connect-auth", intent: "success" }),
				], { gap: 2 });
			}

			// PAGE: RAW DATA
			if (page === "raw") {
				return tray.stack([
					navBar,
					tray.flex([
						tray.text("Change Log (JSON)", { style: { fontWeight: "bold" } }),
						tray.button({ label: "Clear", onClick: "clear-raw", size: "sm", intent: "gray-subtle" }),
					], { justifyContent: "space-between", alignItems: "center" }),
					
					tray.div([
						tray.text(rawDataOutput.get(), { 
							style: { 
								fontFamily: "monospace", 
								fontSize: "11px", 
								whiteSpace: "pre-wrap"
							} 
						})
					], { 
						style: { 
							background: "#111", 
							color: "#0f0", 
							padding: "10px", 
							borderRadius: "5px", 
							maxHeight: "300px", 
							overflowY: "auto",
							width: "100%",
							border: "1px solid #333",
							marginTop: "10px"
						} 
					})
				]);
			}

			return tray.text("Unknown Page");
		});

		// --- LOGIC: EXECUTE FULL SYNC ---
		async function executeFullSync(mode: "ANI_TO_MAL" | "MAL_TO_ANI" | "startup" | "scheduled") {
			if (isSyncing.get()) return;
			if (!isAuthenticated.get()) return;

			// Resolve mode for automated calls
			let direction = mode;
			if (mode === "startup" || mode === "scheduled") {
				direction = $storage.get("malsync.syncMode") || "ANI_TO_MAL";
			}

			isSyncing.set(true);
			shouldStop.set(false);
			syncProgress.set(0);
			syncMessage.set("Starting...");
			addLog(`Starting Sync (${direction})...`, "info");

			// Settings
			const doMirrorDelete = $storage.get("malsync.syncDeletions") === true;
			const doSafeDelete = $storage.get("malsync.syncRemovalsSafe") === true;

			try {
				syncMessage.set("Fetching MAL List...");
				const malList = await fetchFullMalList();
				
				// Map: MAL_ID -> Data
				const malMap = new Map<string, any>();
				const malIds = new Set<string>();

				malList.forEach((item: any) => {
					if (item.node && item.node.id) {
						const strId = String(item.node.id);
						malMap.set(strId, item.list_status || {});
						malIds.add(strId);
					}
				});
				addLog(`Fetched ${malList.length} entries from MAL`, "info");

				if (shouldStop.get()) throw new Error("Cancelled by user");

				syncMessage.set("Fetching AniList...");
				const aniCollection = await $anilist.getAnimeCollection(true);
				
				// Map: AniList_Media_ID -> Entry
				const aniEntryMap = new Map<number, any>();
				// Map: MAL_ID -> AniList_Media_ID
				const malToAniIdMap = new Map<string, number>();
				
				if (aniCollection.MediaListCollection?.lists) {
					aniCollection.MediaListCollection.lists.forEach((list) => {
						if (list.entries) {
							list.entries.forEach(e => {
								aniEntryMap.set(e.media.id, e);
								if (e.media.idMal) {
									malToAniIdMap.set(String(e.media.idMal), e.media.id);
								}
							});
						}
					});
				}
				addLog(`Fetched ${aniEntryMap.size} entries from AniList`, "info");


				// ==========================================
				// DIRECTION: ANILIST -> MAL
				// ==========================================
				if (direction === "ANI_TO_MAL") {
					const total = aniEntryMap.size;
					let processed = 0;
					let updatedCount = 0;
					let createdCount = 0;
					let deletedCount = 0;
					let skippedCount = 0;

					// History for Safe Mode
					const idHistory: Record<string, number> = $storage.get("malsync.idHistory") || {};
					const newIdHistory: Record<string, number> = {};

					// 1. Loop AniList Entries
					for (const [aniId, aniItem] of aniEntryMap.entries()) {
						if (shouldStop.get()) break;
						processed++;

						const malId = aniItem.media.idMal;
						if (!malId) { skippedCount++; continue; }

						const strMalId = String(malId);
						const title = aniItem.media.title?.userPreferred || "Unknown";
						newIdHistory[String(aniId)] = malId; // Update history

						const pct = Math.round((processed / total) * 100);
						syncProgress.set(pct);
						syncMessage.set(`${pct}% - Syncing: ${title}`);

						if (recentlySynced.get().includes(malId)) { skippedCount++; continue; }

						const malItem = malMap.get(strMalId);
						const updateData: Record<string, any> = {};
						let needsUpdate = false;
						const updateReasons: string[] = [];

						// Prepare Data
						const targetStatus = normalizeStatusToMal(aniItem.status || "");
						if (targetStatus) updateData.status = targetStatus;

						let targetScore = Number(aniItem.score || 0);
						if (targetScore > 10) targetScore = Math.round(targetScore / 10);
						updateData.score = targetScore;

						const targetProgress = Number(aniItem.progress || 0);
						updateData.num_watched_episodes = targetProgress;

						if (aniItem.repeat && aniItem.repeat > 0) {
							updateData.num_times_rewatched = Number(aniItem.repeat);
							updateData.is_rewatching = aniItem.status === "REPEATING";
						}

						// Compare
						if (!malItem) {
							needsUpdate = true;
							updateReasons.push("New");
						} else {
							if (targetStatus && String(malItem.status) !== targetStatus) needsUpdate = true;
							if (Number(malItem.score) !== targetScore) needsUpdate = true;
							if (Number(malItem.num_episodes_watched) !== targetProgress) needsUpdate = true;
							if (aniItem.repeat > 0 && Number(malItem.num_times_rewatched) !== Number(aniItem.repeat)) needsUpdate = true;
						}

						if (needsUpdate) {
							try {
								await updateMalEntry(malId, updateData);
								recentlySynced.set([...recentlySynced.get(), malId]);
								appendRawLog(title, !malItem ? "CREATED" : "UPDATED", malItem, aniItem, updateData);
								
								if (!malItem) { createdCount++; addLog(`Created: ${title}`, "success"); }
								else { updatedCount++; addLog(`Updated: ${title}`, "success"); }
								await $_wait(500);
							} catch (e) {
								addLog(`Failed ${title}: ${(e as Error).message}`, "error");
							}
						} else {
							skippedCount++;
						}
					}
					
					$storage.set("malsync.idHistory", newIdHistory);

					// 2. Deletions
					if (!shouldStop.get() && (doMirrorDelete || doSafeDelete)) {
						syncMessage.set("Checking deletions...");
						const malIdsArray = Array.from(malIds);
						
						for(let i=0; i<malIdsArray.length; i++) {
							if (shouldStop.get()) break;
							const mId = malIdsArray[i];
							
							// Check if this MAL ID exists in AniList
							if (!malToAniIdMap.has(mId)) {
								// Not in AniList. Should we delete?
								let shouldDelete = false;
								let reason = "";

								if (doMirrorDelete) {
									shouldDelete = true;
									reason = "Mirror Mode";
								} else if (doSafeDelete) {
									// Only delete if we saw it before (in idHistory)
									// Reverse lookup in history is hard, but we assume 1-to-1
									const historyValues = Object.values(idHistory);
									if (historyValues.includes(Number(mId))) {
										shouldDelete = true;
										reason = "Safe Mode";
									}
								}

								if (shouldDelete) {
									try {
										await deleteMalEntry(Number(mId));
										deletedCount++;
										addLog(`Deleted MAL ID: ${mId} (${reason})`, "warn");
										appendRawLog(`MAL ID ${mId}`, "DELETED", null, null, "DELETE");
										await $_wait(500);
									} catch (e) {
										addLog(`Failed delete ID ${mId}: ${(e as Error).message}`, "error");
									}
								}
							}
						}
					}
					
					if (!shouldStop.get()) {
						addLog(`Done. C:${createdCount} U:${updatedCount} D:${deletedCount} S:${skippedCount}`, "success");
						syncMessage.set("Complete");
					}
				}


				// ==========================================
				// DIRECTION: MAL -> ANILIST
				// ==========================================
				else if (direction === "MAL_TO_ANI") {
					const total = malIds.size;
					let processed = 0;
					let updatedCount = 0;
					let createdCount = 0;

					for (const [strMalId, malItem] of malMap.entries()) {
						if (shouldStop.get()) break;
						processed++;
						
						const malId = Number(strMalId);
						const pct = Math.round((processed / total) * 100);
						syncProgress.set(pct);
						syncMessage.set(`${pct}% - Checking MAL ID: ${malId}`);

						// Find AniList ID
						let aniId = malToAniIdMap.get(strMalId);
						let aniItem = aniId ? aniEntryMap.get(aniId) : null;

						// If not found in local list, fetch ID from API
						if (!aniId) {
							syncMessage.set(`${pct}% - Looking up ID for ${malId}...`);
							const fetchedId = await getAniListIdByMalId(malId);
							if (fetchedId) {
								aniId = fetchedId;
								// Fetch fresh entry data just in case (or assume null means new)
							} else {
								addLog(`Skipped MAL ID ${malId}: Could not find AniList match`, "warn");
								continue;
							}
						}

						// Data to Push to AniList
						const aniStatus = normalizeStatusToAni(malItem.status);
						let aniScore = Number(malItem.score) || 0;
						// Assuming AniList user uses 100 point scale, multiply by 10? 
						// Or simpler: send raw. Seanime usually handles it.
						// Let's multiply by 10 if it's small to be safe for default settings.
						if (aniScore > 0 && aniScore <= 10) aniScore = aniScore * 10; 

						const aniProgress = Number(malItem.num_episodes_watched) || 0;
						const aniRepeat = Number(malItem.num_times_rewatched) || 0;

						// Comparison
						let needsUpdate = false;
						if (!aniItem) {
							needsUpdate = true; // New entry
						} else {
							if (aniStatus && aniItem.status !== aniStatus) needsUpdate = true;
							if (aniItem.progress !== aniProgress) needsUpdate = true;
							// Score comparison is fuzzy due to formats, update if difference > 1
							const currentAniScore = aniItem.score || 0;
							if (Math.abs(currentAniScore - aniScore) > 1) needsUpdate = true;
							if (aniItem.repeat !== aniRepeat) needsUpdate = true;
						}

						if (needsUpdate) {
							try {
								// AniList Update
								await $anilist.updateEntry(aniId, aniStatus, aniScore, aniProgress, undefined, undefined);
								if (aniRepeat > 0) {
									await $anilist.updateEntryRepeat(aniId, aniRepeat);
								}

								if (!aniItem) {
									createdCount++;
									addLog(`Imported to AniList: ID ${aniId}`, "success");
								} else {
									updatedCount++;
									addLog(`Updated AniList: ID ${aniId}`, "success");
								}
								appendRawLog(`ID ${aniId}`, "IMPORT_FROM_MAL", aniItem, malItem, "UPDATE_ANILIST");
								await $_wait(500);
							} catch (e) {
								addLog(`Failed to import ID ${aniId}: ${(e as Error).message}`, "error");
							}
						}
					}

					if (!shouldStop.get()) {
						addLog(`Import Complete. Created: ${createdCount}, Updated: ${updatedCount}`, "success");
						syncMessage.set("Complete");
					}
				}

			} catch (e) {
				if (e.message !== "Cancelled by user") {
					addLog(`Sync Failed: ${(e as Error).message}`, "error");
				}
				syncMessage.set("Stopped");
			} finally {
				isSyncing.set(false);
				shouldStop.set(false);
				await $_wait(2000);
				syncProgress.set(0);
				syncMessage.set("");
			}
		}

		// --- LIVE SYNC LOGIC (Hooks) ---

		async function handlePostUpdateEntry(
			e: $app.PostUpdateEntryEvent | $app.PostUpdateEntryProgressEvent | $app.PostUpdateEntryRepeatEvent
		) {
			// FEATURE: Check Live Sync Setting
			const liveEnabled = $storage.get("malsync.liveSync") ?? true;
			if (!liveEnabled) return;

			if (!isAuthenticated.get()) return;
			if (isSyncing.get()) return; 
			if (!e.mediaId) return;

			const anime = $anilist.getAnime(e.mediaId);
			if (!anime || !anime.idMal) return;

			const malId = anime.idMal;
			const title = anime.title?.userPreferred || malId.toString();

			addLog(`Auto-Syncing: ${title}...`, "info");

			const entry = await ctx.anime.getAnimeEntry(e.mediaId);
			const aniItem = entry.listData;

			try {
				await $_wait(1000); 

				const fieldsParam = "fields=list_status{status,score,num_episodes_watched,is_rewatching,num_times_rewatched}";
				const url = `${BASE_URI_V2}/anime/${malId}?${fieldsParam}`;
				
				let malItem = null;
				try {
					const res = await ctx.fetch(url, { headers: await tokenManager.withAuthHeaders() });
					if(res.ok) {
						const data = await res.json();
						malItem = data.list_status;
					}
				} catch(ignore) {}

				if (!aniItem) {
					const doDeletions = $storage.get("malsync.syncDeletions") === true;
					if (doDeletions) {
						await deleteMalEntry(malId);
						addLog(`Removed: ${title}`, "warn");
						appendRawLog(title, "DELETED", malItem, "null", "DELETE");
					} else {
						addLog(`Ignored delete for: ${title} (Settings disabled)`, "info");
					}
					return;
				}

				const updateData: Record<string, any> = {};
				let needsUpdate = false;

				const targetStatus = normalizeStatusToMal(aniItem.status || "");
				if (targetStatus) updateData.status = targetStatus;

				let targetScore = Number(aniItem.score || 0);
				if (targetScore > 10) targetScore = Math.round(targetScore / 10);
				updateData.score = targetScore;

				const targetProgress = Number(aniItem.progress || 0);
				updateData.num_watched_episodes = targetProgress;

				const targetRewatch = Number(aniItem.repeat || 0);
				if (targetRewatch > 0) {
					updateData.num_times_rewatched = targetRewatch;
					updateData.is_rewatching = aniItem.status === "REPEATING";
				}

				if (!malItem) {
					needsUpdate = true;
				} else {
					const currentStatus = String(malItem.status || "");
					if (targetStatus && currentStatus !== targetStatus) needsUpdate = true;
					
					const currentScore = Number(malItem.score || 0);
					if (currentScore !== targetScore) needsUpdate = true;
					
					const currentEp = Number(malItem.num_episodes_watched || 0);
					if (currentEp !== targetProgress) needsUpdate = true;
					
					const currentRewatch = Number(malItem.num_times_rewatched || 0);
					if (targetRewatch > 0 && currentRewatch !== targetRewatch) needsUpdate = true;
				}

				if (needsUpdate) {
					await updateMalEntry(malId, updateData);
					addLog(`Updated: ${title}`, "success");
					appendRawLog(title, !malItem ? "CREATED" : "UPDATED", malItem, { status: aniItem.status, score: aniItem.score, progress: aniItem.progress }, updateData);
				} else {
					addLog(`Skipped: ${title} (Synced)`, "info");
				}

			} catch (err) {
				addLog(`Failed ${title}: ${(err as Error).message}`, "error");
			}
		}

		$store.watch("POST_UPDATE_ENTRY", handlePostUpdateEntry);
		$store.watch("POST_UPDATE_ENTRY_PROGRESS", handlePostUpdateEntry);
		$store.watch("POST_UPDATE_ENTRY_REPEAT", handlePostUpdateEntry);
	});

	// --- HOOKS ---
	$app.onPostUpdateEntry((e) => {
		$store.set("POST_UPDATE_ENTRY", $clone(e));
		e.next();
	});

	$app.onPostUpdateEntryProgress((e) => {
		$store.set("POST_UPDATE_ENTRY_PROGRESS", $clone(e));
		e.next();
	});

	$app.onPostUpdateEntryRepeat((e) => {
		$store.set("POST_UPDATE_ENTRY_REPEAT", $clone(e));
		e.next();
	});
}
