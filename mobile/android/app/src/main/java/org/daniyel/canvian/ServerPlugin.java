package org.daniyel.canvian;

import android.content.Context;
import android.content.SharedPreferences;
import android.net.Uri;
import android.webkit.CookieManager;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * La app no lleva la web dentro: abre la de tu servidor, así que cada cambio
 * que se despliega llega a la vez a la web y al móvil. Este plugin guarda qué
 * servidor es y decide qué se abre dentro de la app: ese servidor y la
 * pantalla de elegirlo (localhost) sí; cualquier otro enlace, en el navegador.
 */
@CapacitorPlugin(name = "Server")
public class ServerPlugin extends Plugin {

    private static final String PREFS = "canvian";
    private static final String KEY = "server";

    private SharedPreferences prefs() {
        return getContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    @PluginMethod
    public void get(PluginCall call) {
        JSObject ret = new JSObject();
        ret.put("url", prefs().getString(KEY, null));
        call.resolve(ret);
    }

    @PluginMethod
    public void set(PluginCall call) {
        String url = call.getString("url");
        if (url == null || Uri.parse(url).getHost() == null) {
            call.reject("Dirección no válida");
            return;
        }
        prefs().edit().putString(KEY, url).apply();
        call.resolve();
    }

    @Override
    public Boolean shouldOverrideLoad(Uri url) {
        String scheme = url.getScheme();
        if (!"http".equals(scheme) && !"https".equals(scheme)) return null;
        String host = url.getHost();
        if (host == null || host.equals("localhost")) return null;
        String saved = prefs().getString(KEY, null);
        if (saved != null && host.equals(Uri.parse(saved).getHost())) return false;
        // Lo demás (enlaces de las notas, etc.) sale al navegador.
        return null;
    }

    @Override
    protected void handleOnPause() {
        // Que la sesión no se pierda si Android cierra la app.
        CookieManager.getInstance().flush();
    }
}
