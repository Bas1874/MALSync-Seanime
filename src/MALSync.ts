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
		const syncDeletionsRef = ctx.fieldRef<boolean>($storage.get("malsync.syncDeletions") ?? false);

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
[MAL BEFORE]: ${JSON.stringify(malData || "null")}
[ANILIST SOURCE]: ${JSON.stringify(aniData)}
[PAYLOAD SENT]: ${JSON.stringify(payload, null, 2)}
==================================================
`;
			const current = rawDataOutput.get();
			const truncated = current.length > 50000 ? current.substring(0, 50000) + "\n...[Old logs truncated]" : current;
			rawDataOutput.set(entry + "\n" + truncated);
		}

		function $_wait(ms: number): Promise<void> {
			return new Promise((resolve) => ctx.setTimeout(resolve, ms));
		}

		function normalizeStatus(statusAL: string): string | null {
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
			$storage.set("malsync.syncDeletions", syncDeletionsRef.current);
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

		// --- FULL SYNC HANDLER ---
		ctx.registerEventHandler("run-full-sync", async () => {
			if (isSyncing.get()) return;
			isSyncing.set(true);
			shouldStop.set(false);
			syncProgress.set(0);
			syncMessage.set("Starting...");
			addLog("Starting Full Sync...", "info");

			try {
				syncMessage.set("Fetching MAL List...");
				const malList = await fetchFullMalList();
				
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
				
				let aniEntries: $app.AL_AnimeCollection_MediaListCollection_Lists_Entries[] = [];
				if (aniCollection.MediaListCollection?.lists) {
					aniCollection.MediaListCollection.lists.forEach((list) => {
						if (list.entries) aniEntries = aniEntries.concat(list.entries);
					});
				}
				addLog(`Fetched ${aniEntries.length} entries from AniList`, "info");

				let updatedCount = 0;
				let skippedCount = 0;
				let createdCount = 0;
				let deletedCount = 0;
				const total = aniEntries.length;
				
				const currentSession = recentlySynced.get();
				const aniIdsFound = new Set<string>();

				// --- PHASE 1: SYNC ANI -> MAL
				for (let i = 0; i < total; i++) {
					if (shouldStop.get()) break;

					const aniItem = aniEntries[i];
					const malId = aniItem.media.idMal;
					
					if (!malId) {
						skippedCount++;
						continue; 
					}

					const strMalId = String(malId);
					aniIdsFound.add(strMalId);

					const title = aniItem.media.title?.userPreferred || "Unknown";

					const pct = Math.round(((i + 1) / total) * 100);
					syncProgress.set(pct);
					syncMessage.set(`${pct}% - Syncing: ${title}`);

					if (currentSession.includes(malId)) {
						skippedCount++;
						continue;
					}

					const malItem = malMap.get(strMalId);
					const updateData: Record<string, any> = {};
					let needsUpdate = false;
					const updateReasons: string[] = [];

					// 1. Prepare Data
					const targetStatus = normalizeStatus(aniItem.status || "");
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

					// 2. Logic
					if (!malItem) {
						needsUpdate = true;
						updateReasons.push("New Entry");
					} else {
						const currentStatus = String(malItem.status || "");
						if (targetStatus && currentStatus !== targetStatus) {
							needsUpdate = true;
							updateReasons.push(`Status: ${currentStatus}->${targetStatus}`);
						}
						
						const currentScore = Number(malItem.score || 0);
						if (currentScore !== targetScore) {
							needsUpdate = true;
							updateReasons.push(`Score: ${currentScore}->${targetScore}`);
						}
						
						const currentEp = Number(malItem.num_episodes_watched || 0);
						if (currentEp !== targetProgress) {
							needsUpdate = true;
							updateReasons.push(`Ep: ${currentEp}->${targetProgress}`);
						}
						
						const currentRewatch = Number(malItem.num_times_rewatched || 0);
						if (targetRewatch > 0 && currentRewatch !== targetRewatch) {
							needsUpdate = true;
							updateReasons.push(`Rewatch: ${currentRewatch}->${targetRewatch}`);
						}
					}

					if (needsUpdate) {
						try {
							await updateMalEntry(malId, updateData);
							recentlySynced.set([...recentlySynced.get(), malId]);

							appendRawLog(title, !malItem ? "CREATED" : "UPDATED", malItem, { status: aniItem.status, score: aniItem.score, progress: aniItem.progress }, updateData);

							if (!malItem) {
								createdCount++;
								addLog(`Created: ${title}`, "success");
							} else {
								updatedCount++;
								addLog(`Updated: ${title} [${updateReasons.join(", ")}]`, "success");
							}
							await $_wait(500); 
						} catch (e) {
							addLog(`Failed: ${title} - ${(e as Error).message}`, "error");
						}
					} else {
						skippedCount++;
					}
				}

				// --- PHASE 2: HANDLE DELETIONS
				if (!shouldStop.get() && syncDeletionsRef.current) {
					syncMessage.set("Checking for deletions...");
					
					const toDelete = Array.from(malIds).filter(id => !aniIdsFound.has(id));
					
					if (toDelete.length > 0) {
						addLog(`Found ${toDelete.length} items to delete from MAL`, "warn");
						
						for (let i = 0; i < toDelete.length; i++) {
							if (shouldStop.get()) break;
							
							const idToDelete = Number(toDelete[i]);
							const pct = Math.round(((i + 1) / toDelete.length) * 100);
							syncProgress.set(pct);
							syncMessage.set(`${pct}% - Deleting ID: ${idToDelete}`);

							try {
								await deleteMalEntry(idToDelete);
								deletedCount++;
								addLog(`Deleted MAL ID: ${idToDelete} (Not in AniList)`, "warn");
								appendRawLog(`MAL ID ${idToDelete}`, "DELETED_SYNC", null, "Not in AniList", "DELETE");
								await $_wait(500);
							} catch (e) {
								addLog(`Failed to delete ID ${idToDelete}: ${(e as Error).message}`, "error");
							}
						}
					}
				}

				if (!shouldStop.get()) {
					const delMsg = syncDeletionsRef.current ? `, Deleted: ${deletedCount}` : "";
					addLog(`Sync Complete. Created: ${createdCount}, Updated: ${updatedCount}${delMsg}, Synced: ${skippedCount}`, "success");
					syncMessage.set("Complete");
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
		});

		// --- INITIALIZATION ---

		if (tokenManager.getAccessToken()) {
			isAuthenticated.set(true);
			statusText.set("Authenticated");
			statusIntent.set("success");
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
					: isAuthenticated.get() ? tray.button({ 
						label: "Sync Now (AniList -> MAL)", 
						onClick: "run-full-sync", 
						intent: "primary" 
					}) : tray.text(""), 

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
					tray.checkbox({ fieldRef: syncDeletionsRef, label: "Sync Deletions (Danger!)" }),
					tray.button({ label: "Save Preferences", onClick: "save-prefs", intent: "primary", size: "sm" }),
					
					tray.div([], { style: { height: "1px", background: "#444", margin: "10px 0" } }),

					// 2. Connection Setup (Bottom)
					tray.text("Connection Setup", { style: { fontWeight: "bold" } }),
					
					// NEW: Clickable Link for Config Page
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
					
					tray.button({ label: "Save Keys (Generates Link)", onClick: "save-config", intent: "primary", size: "sm" }),
					
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

		// --- LIVE SYNC LOGIC (Hooks) ---

		async function handlePostUpdateEntry(
			e: $app.PostUpdateEntryEvent | $app.PostUpdateEntryProgressEvent | $app.PostUpdateEntryRepeatEvent
		) {
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

				// Fetch Current MAL State
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
					if (syncDeletionsRef.current) {
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

				const targetStatus = normalizeStatus(aniItem.status || "");
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
