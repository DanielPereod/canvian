--[[
Canvian para KOReader: manda los subrayados y notas de tus libros a Canvian.
Cada libro es una nota dentro de la carpeta elegida en Canvian
(Configuración › KOReader). Volver a sincronizar actualiza esa nota, no la
duplica. La dirección, la llave y el perfil vienen en canvian_config.lua (lo
genera Canvian al descargar el plugin) y se pueden cambiar desde el menú.
]]

local ButtonDialog = require("ui/widget/buttondialog")
local DataStorage = require("datastorage")
local DocSettings = require("docsettings")
local InfoMessage = require("ui/widget/infomessage")
local InputDialog = require("ui/widget/inputdialog")
local NetworkMgr = require("ui/network/manager")
local UIManager = require("ui/uimanager")
local WidgetContainer = require("ui/widget/container/widgetcontainer")
local JSON = require("json")
local http = require("socket.http")
local logger = require("logger")
local ltn12 = require("ltn12")
local socket = require("socket")
local socketutil = require("socketutil")

local SETTINGS = "canvian"

-- Lo que generó Canvian al descargar el plugin.
local function pluginDir()
    local source = debug.getinfo(1, "S").source or ""
    return source:match("^@(.*)/[^/]*$") or "."
end

local function loadConfig()
    local ok, config = pcall(dofile, pluginDir() .. "/canvian_config.lua")
    if ok and type(config) == "table" then return config end
    return {}
end

local TEXTS = {
    es = {
        sync_book = "Sincronizar este libro",
        sync_all = "Sincronizar todos los libros",
        auto = "Sincronizar al cerrar un libro",
        profile = "Perfil",
        server = "Dirección de Canvian",
        key = "Llave",
        key_hint = "La de Configuración › KOReader en Canvian",
        cancel = "Cancelar",
        save = "Guardar",
        no_server = "Falta la dirección o la llave de Canvian.",
        syncing = "Sincronizando con Canvian…",
        created = "Nota creada en Canvian: %1 (%2 subrayados).",
        updated = "Nota actualizada en Canvian: %1 (%2 subrayados).",
        same = "Ya estaba al día: %1.",
        empty = "Este libro no tiene subrayados ni notas.",
        all_done = "Libros sincronizados: %1 (nuevos: %2, actualizados: %3).",
        failed = "No se ha podido sincronizar: %1",
        choose_profile = "Elige el perfil de Canvian",
        none = "ninguno",
        untitled = "Libro sin título",
    },
    en = {
        sync_book = "Sync this book",
        sync_all = "Sync all books",
        auto = "Sync when closing a book",
        profile = "Profile",
        server = "Canvian address",
        key = "Key",
        key_hint = "The one in Canvian's Settings › KOReader",
        cancel = "Cancel",
        save = "Save",
        no_server = "The Canvian address or key is missing.",
        syncing = "Syncing with Canvian…",
        created = "Note created in Canvian: %1 (%2 highlights).",
        updated = "Note updated in Canvian: %1 (%2 highlights).",
        same = "Already up to date: %1.",
        empty = "This book has no highlights or notes.",
        all_done = "Books synced: %1 (new: %2, updated: %3).",
        failed = "Couldn't sync: %1",
        choose_profile = "Choose the Canvian profile",
        none = "none",
        untitled = "Untitled book",
    },
}

local function fill(text, ...)
    local args = { ... }
    return (text:gsub("%%(%d)", function(i) return tostring(args[tonumber(i)] or "") end))
end

local Canvian = WidgetContainer:extend{
    name = "canvian",
    is_doc_only = false,
}

function Canvian:init()
    local config = loadConfig()
    -- Lo cambiado desde el menú manda, salvo que se haya instalado otro plugin descargado.
    local stamp = tostring(config.token) .. "|" .. tostring(config.url) .. "|" .. tostring(config.profile)
    local saved = G_reader_settings:readSetting(SETTINGS) or {}
    if saved.stamp ~= stamp then
        saved = { stamp = stamp, auto = saved.auto }
    end
    self.saved = saved
    self.config = config
    self.L = TEXTS[config.lang] or TEXTS.es
    self.ui.menu:registerToMainMenu(self)
end

function Canvian:get(key)
    if self.saved[key] ~= nil then return self.saved[key] end
    return self.config[key]
end

function Canvian:set(key, value)
    self.saved[key] = value
    G_reader_settings:saveSetting(SETTINGS, self.saved)
end

function Canvian:say(text, timeout)
    UIManager:show(InfoMessage:new{ text = text, timeout = timeout or 3 })
end

-- ── Red ──────────────────────────────────────────────────────────────

-- body es una tabla (va como JSON) o { raw = datos, type = "image/jpeg" }.
function Canvian:request(method, path, body, quick)
    local base = (self:get("url") or ""):gsub("/+$", "")
    local token = self:get("token")
    if base == "" or not token or token == "" then return nil, self.L.no_server end
    local sink = {}
    local headers = {
        ["Authorization"] = "Bearer " .. token,
        ["Accept"] = "application/json",
    }
    local source
    if body then
        local data = body.raw or JSON.encode(body)
        headers["Content-Type"] = body.raw and body.type or "application/json"
        headers["Content-Length"] = tostring(#data)
        source = ltn12.source.string(data)
    end
    if quick then
        socketutil:set_timeout(socketutil.DEFAULT_BLOCK_TIMEOUT, socketutil.DEFAULT_TOTAL_TIMEOUT)
    else
        socketutil:set_timeout(socketutil.LARGE_BLOCK_TIMEOUT, socketutil.LARGE_TOTAL_TIMEOUT)
    end
    local code, _, status = socket.skip(1, http.request{
        url = base .. path,
        method = method,
        headers = headers,
        source = source,
        sink = ltn12.sink.table(sink),
    })
    socketutil:reset_timeout()
    local raw = table.concat(sink)
    local ok, data = pcall(JSON.decode, raw)
    if type(code) ~= "number" then
        return nil, tostring(code or status)
    end
    if code < 200 or code >= 300 then
        return nil, (ok and type(data) == "table" and data.error) or ("HTTP " .. code)
    end
    return (ok and type(data) == "table") and data or {}
end

-- ── Los subrayados de un libro ───────────────────────────────────────

-- Los marcadores de antes ponían «Página 12 …» como nota cuando no había ninguna.
local function realNote(note, text)
    if type(note) ~= "string" or note == "" or note == text then return nil end
    if note:match("^Page %d+ ") or note:match("^Página %d+ ") then return nil end
    return note
end

-- KOReader 2024.07 en adelante: «annotations»; antes, «bookmarks».
local function normalize(list, old)
    local out = {}
    for _, a in ipairs(list or {}) do
        local text, note, page
        if old then
            if a.highlighted then
                text = a.notes
                note = realNote(a.text, a.notes)
            end
            page = type(a.page) == "number" and a.page or nil
        else
            text = a.text
            note = a.note
            page = a.pageno or (type(a.page) == "number" and a.page or nil)
        end
        if (type(text) == "string" and text ~= "") or (type(note) == "string" and note ~= "") then
            table.insert(out, {
                text = type(text) == "string" and text or nil,
                note = type(note) == "string" and note or nil,
                chapter = type(a.chapter) == "string" and a.chapter or nil,
                page = page and tostring(page) or nil,
                datetime = a.datetime_updated or a.datetime,
            })
        end
    end
    return out
end

local function fileTitle(file)
    local name = (file or ""):match("([^/]+)$") or ""
    return (name:gsub("%.[^.]+$", ""))
end

local function bookOf(props, key, file, untitled)
    props = props or {}
    local title = props.display_title or props.title
    if not title or title == "" then title = fileTitle(file) end
    if title == "" then title = untitled end
    return {
        key = key or ("file:" .. tostring(file)),
        title = title,
        authors = props.authors,
    }
end

-- El libro abierto, con lo que hay ahora en memoria.
function Canvian:openBook()
    local ui = self.ui
    if not ui.document then return nil end
    local list, old
    if ui.annotation and ui.annotation.annotations then
        list = ui.annotation.annotations
    elseif ui.bookmark and ui.bookmark.bookmarks then
        list, old = ui.bookmark.bookmarks, true
    end
    local file = ui.document.file
    local key = ui.doc_settings and ui.doc_settings:readSetting("partial_md5_checksum")
    return {
        file = file,
        doc = ui.document,
        book = bookOf(ui.doc_props or (ui.doc_settings and ui.doc_settings:readSetting("doc_props")), key, file, self.L.untitled),
        annotations = normalize(list, old),
    }
end

-- Un libro del historial, leído de su archivo de ajustes (.sdr).
function Canvian:storedBook(file)
    local ok, ds = pcall(DocSettings.open, DocSettings, file)
    if not ok or not ds then return nil end
    local list, old = ds:readSetting("annotations"), false
    if not list then list, old = ds:readSetting("bookmarks"), true end
    if not list then return nil end
    return {
        file = file,
        book = bookOf(ds:readSetting("doc_props"), ds:readSetting("partial_md5_checksum"), file, self.L.untitled),
        annotations = normalize(list, old),
    }
end

-- ── La portada ───────────────────────────────────────────────────────

local COVER_HEIGHT = 800

-- La portada como imagen (JPEG, o PNG en versiones de KOReader que no saben
-- escribir JPEG), reducida para no mandar megas. nil si no se puede sacar.
local function coverImage(doc, file)
    local ok, bb = pcall(function()
        local BookInfo = require("apps/filemanager/filemanagerbookinfo")
        return BookInfo:getCoverImage(doc, file)
    end)
    if not ok or not bb then return nil end
    local w, h = bb:getWidth(), bb:getHeight()
    if h > COVER_HEIGHT then
        local okScale, scaled = pcall(function()
            local RenderImage = require("ui/renderimage")
            return RenderImage:scaleBlitBuffer(bb, math.floor(w * COVER_HEIGHT / h), COVER_HEIGHT)
        end)
        if okScale and scaled and scaled ~= bb then
            bb:free()
            bb = scaled
        end
    end
    local path = DataStorage:getDataDir() .. "/canvian-cover"
    local mime
    if bb.writeToFile and pcall(bb.writeToFile, bb, path, "jpg", 85) then
        mime = "image/jpeg"
    elseif bb.writePNG and pcall(bb.writePNG, bb, path) then
        mime = "image/png"
    end
    bb:free()
    if not mime then return nil end
    local f = io.open(path, "rb")
    if not f then return nil end
    local data = f:read("*a")
    f:close()
    os.remove(path)
    if not data or data == "" then return nil end
    return data, mime
end

-- Una vez por libro: Canvian dice en la respuesta si aún no tiene su portada.
function Canvian:sendCover(item, result, quick)
    if not (result and result.cover and result.id) then return end
    local ok, err = pcall(function()
        local doc = item.doc
        local data, mime = coverImage(doc, not doc and item.file or nil)
        if not data then return end
        local _, fail = self:request("POST", "/koreader/cover/" .. result.id, { raw = data, type = mime }, quick)
        if fail then logger.warn("Canvian: no se ha podido mandar la portada", item.file, fail) end
    end)
    if not ok then logger.warn("Canvian: portada", err) end
end

function Canvian:send(item, quick)
    local result, err = self:request("POST", "/koreader/sync", {
        profile = self:get("profile"),
        book = item.book,
        annotations = item.annotations,
    }, quick)
    if result and not result.skipped then self:sendCover(item, result, quick) end
    return result, err
end

-- ── Acciones ─────────────────────────────────────────────────────────

function Canvian:online(fn)
    if NetworkMgr.runWhenOnline then
        NetworkMgr:runWhenOnline(fn)
    else
        fn()
    end
end

function Canvian:syncOpen()
    local item = self:openBook()
    if not item then return end
    if #item.annotations == 0 then
        self:say(self.L.empty)
    end
    self:online(function()
        local result, err = self:send(item)
        if not result then
            self:say(fill(self.L.failed, err), 5)
        elseif result.skipped then
            return
        elseif result.created then
            self:say(fill(self.L.created, result.title, result.count))
        elseif result.changed then
            self:say(fill(self.L.updated, result.title, result.count))
        else
            self:say(fill(self.L.same, result.title))
        end
    end)
end

function Canvian:syncAll()
    self:online(function()
        local waiting = InfoMessage:new{ text = self.L.syncing }
        UIManager:show(waiting)
        UIManager:forceRePaint()
        local open = self.ui.document and self.ui.document.file
        local items = {}
        if open then table.insert(items, self:openBook()) end
        local ok, ReadHistory = pcall(require, "readhistory")
        if ok and ReadHistory then
            if ReadHistory.reload then pcall(ReadHistory.reload, ReadHistory) end
            for _, entry in ipairs(ReadHistory.hist or {}) do
                if entry.file and entry.file ~= open then
                    local item = self:storedBook(entry.file)
                    if item and #item.annotations > 0 then table.insert(items, item) end
                end
            end
        end
        local synced, created, changed, failure = 0, 0, 0, nil
        for _, item in ipairs(items) do
            local result, err = self:send(item)
            if not result then
                failure = err
                logger.warn("Canvian: no se ha podido sincronizar", item.file, err)
                -- Sin llave o sin servidor, no tiene sentido seguir.
                if err == self.L.no_server or tostring(err):match("401") or tostring(err):match("[Ll]lave") or tostring(err):match("[Kk]ey") then break end
            elseif not result.skipped then
                synced = synced + 1
                if result.created then created = created + 1 elseif result.changed then changed = changed + 1 end
            end
        end
        UIManager:close(waiting)
        if failure and synced == 0 then
            self:say(fill(self.L.failed, failure), 5)
        else
            self:say(fill(self.L.all_done, synced, created, changed), 4)
        end
    end)
end

-- Al cerrar un libro, en silencio y solo si ya hay red (no se enciende el wifi para esto).
function Canvian:onCloseDocument()
    if not self.saved.auto or not self.ui.document then return end
    if NetworkMgr.isOnline and not NetworkMgr:isOnline() then return end
    local ok, err = pcall(function()
        local item = self:openBook()
        if item then
            local _, fail = self:send(item, true)
            if fail then logger.warn("Canvian: no se ha podido sincronizar al cerrar", fail) end
        end
    end)
    if not ok then logger.warn("Canvian:", err) end
end

function Canvian:chooseProfile(menu)
    self:online(function()
        local result, err = self:request("GET", "/koreader/profiles")
        if not result then
            self:say(fill(self.L.failed, err), 5)
            return
        end
        local dialog
        local buttons = {}
        for _, p in ipairs(result.profiles or {}) do
            table.insert(buttons, { {
                text = (p.id == self:get("profile") and "✓ " or "") .. p.name,
                callback = function()
                    self:set("profile", p.id)
                    self:set("profile_name", p.name)
                    UIManager:close(dialog)
                    if menu and menu.updateItems then menu:updateItems() end
                end,
            } })
        end
        dialog = ButtonDialog:new{ title = self.L.choose_profile, buttons = buttons }
        UIManager:show(dialog)
    end)
end

function Canvian:edit(key, title, hint, menu)
    local dialog
    dialog = InputDialog:new{
        title = title,
        description = hint,
        input = self:get(key) or "",
        buttons = { {
            {
                text = self.L.cancel,
                id = "close",
                callback = function() UIManager:close(dialog) end,
            },
            {
                text = self.L.save,
                is_enter_default = true,
                callback = function()
                    local value = dialog:getInputText():gsub("^%s+", ""):gsub("%s+$", "")
                    if key == "url" then value = value:gsub("/+$", "") end
                    self:set(key, value)
                    UIManager:close(dialog)
                    if menu and menu.updateItems then menu:updateItems() end
                end,
            },
        } },
    }
    UIManager:show(dialog)
    dialog:onShowKeyboard()
end

function Canvian:addToMainMenu(menu_items)
    local L = self.L
    menu_items.canvian = {
        text = "Canvian",
        sorting_hint = "tools",
        sub_item_table = {
            {
                text = L.sync_book,
                enabled_func = function() return self.ui.document ~= nil end,
                callback = function() self:syncOpen() end,
            },
            {
                text = L.sync_all,
                callback = function() self:syncAll() end,
            },
            {
                text = L.auto,
                checked_func = function() return self.saved.auto == true end,
                callback = function() self:set("auto", not self.saved.auto) end,
                separator = true,
            },
            {
                text_func = function() return L.profile .. ": " .. (self:get("profile_name") or L.none) end,
                keep_menu_open = true,
                callback = function(menu) self:chooseProfile(menu) end,
            },
            {
                text_func = function() return L.server .. ": " .. (self:get("url") or "") end,
                keep_menu_open = true,
                callback = function(menu) self:edit("url", L.server, "https://…", menu) end,
            },
            {
                text = L.key,
                keep_menu_open = true,
                callback = function(menu) self:edit("token", L.key, L.key_hint, menu) end,
            },
        },
    }
end

return Canvian
