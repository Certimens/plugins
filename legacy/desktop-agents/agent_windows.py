import ctypes
import time
import os
import sys
import psutil
import win32gui
import win32process
import win32com.client
import win32clipboard
import pythoncom
import json
import uuid
import threading
import urllib.request
import re
import base64
import statistics
from datetime import datetime, timezone
from pynput import keyboard, mouse
import pystray
from pystray import MenuItem as item
from PIL import Image, ImageDraw
import tkinter as tk
from tkinter import messagebox
from http.server import BaseHTTPRequestHandler, HTTPServer

# ==========================================
# CONFIGURATION SERVEUR & VERSION
# ==========================================
AGENT_VERSION = "5.7 - Restart Doux & Flush (Windows)" 
URL_SERVEUR = base64.b64decode("aHR0cDovLzE1Mi4yMjguMTQwLjIyOTo4MDgwL3RlbGVtZXRyeQ==").decode('utf-8')
CLE_SECURITE = base64.b64decode("Q0VSVElNRU5TX1NFQ1VSRV9LRVlfMjAyNg==").decode('utf-8')

# ==========================================
# ÉTAT GLOBAL & CACHE LOCAL
# ==========================================
agent_running = True
is_paused = False
mute_alerts = False

app_data_dir = os.path.join(os.getenv('APPDATA'), "Certimens")
if not os.path.exists(app_data_dir): os.makedirs(app_data_dir)

CONFIG_FILE = os.path.join(app_data_dir, "certimens_config.json")
CACHE_FILE = os.path.join(app_data_dir, "certimens_cache.json")

student_email = ""
global_icon = None

fenetres_connues = {}
ignored_hwnds = set()
popup_cooldowns = {}

dernier_hwnd_cible = 0
session_actuelle_id = ""
nom_fenetre_actuelle = ""

word_session_uuid = ""
word_is_ghost = False
session_web_id = None 

# --- VARIABLES IFC & FLUSH ---
touches_enfoncees = set()
injections_detectees = []
flight_times = []
last_press_time = 0
timestamp_debut = None

# Gestion du temps effectif et AFK
last_event_time = 0
last_activity_time = 0
packet_active_time_ms = 0
packet_keystrokes = 0

# Compteurs Micro & Macro
corrections_immediates = 0
reformulations_differees = 0
sauts_navigation = 0
is_navigating = False
macro_repentirs = 0
pauses_cognitives = 0
mouse_clicked_recently = False

# Variables de surveillance du Focus & Disque
was_word_focused = False
last_mtime = 0
last_char_count = -1
last_hwnd_word = 0
data_lock = threading.RLock()

def calculate_mad(data):
    if len(data) < 2: return 0.0
    med = statistics.median(data)
    deviations = [abs(x - med) for x in data]
    return statistics.median(deviations)

# ==========================================
# VIDANGE INTELLIGENTE (FLUSH)
# ==========================================
def vider_memoire_tampon():
    global packet_active_time_ms, packet_keystrokes, last_activity_time
    global corrections_immediates, reformulations_differees, sauts_navigation, flight_times
    global macro_repentirs, pauses_cognitives
    global injections_detectees, timestamp_debut

    with data_lock:
        if packet_keystrokes > 0 or len(injections_detectees) > 0:
            current_utc = int(datetime.now(timezone.utc).timestamp())
            nouveau_paquet = {
                "student_email": student_email,
                "hardware_id": str(uuid.getnode()),
                "session_id": session_actuelle_id,
                "active_window": nom_fenetre_actuelle,
                "timestamp_debut": timestamp_debut,
                "timestamp_fin": current_utc,
                "temps_actif_ms": int(packet_active_time_ms),
                "temps_effectif_secondes": int(packet_active_time_ms / 1000), 
                "injections_detectees": list(injections_detectees),
                "metrics": {
                    "total_frappes_brutes": packet_keystrokes,
                    "corrections_immediates": corrections_immediates,
                    "reformulations_differees": reformulations_differees,
                    "sauts_navigation": sauts_navigation,
                    "macro_repentirs": macro_repentirs,
                    "pauses_cognitives": pauses_cognitives,
                    "mad_moyen_ms": round(calculate_mad(flight_times), 2)
                }
            }
            threading.Thread(target=envoyer_donnees, args=(nouveau_paquet,), daemon=True).start()
            
            # Remise à zéro post-vidange
            injections_detectees, flight_times = [], []
            timestamp_debut = None
            packet_active_time_ms, packet_keystrokes, last_activity_time = 0, 0, 0
            corrections_immediates, reformulations_differees, sauts_navigation = 0, 0, 0
            macro_repentirs, pauses_cognitives = 0, 0

# ==========================================
# FONCTION DE TATOUAGE
# ==========================================
def injecter_uuid_google_doc(filepath, doc_id_navigateur):
    filepath = os.path.normpath(filepath)
    succes = False
    id_final = f"GDOCS-{doc_id_navigateur}" if not str(doc_id_navigateur).startswith("GDOCS-") else str(doc_id_navigateur)
    try: os.remove(filepath + ":Zone.Identifier")
    except Exception: pass
    
    for tentative in range(15):
        word_app = None
        try:
            time.sleep(1.0) 
            pythoncom.CoInitialize()
            word_app = win32com.client.DispatchEx("Word.Application")
            word_app.Visible = False
            word_app.DisplayAlerts = False 
            
            doc = word_app.Documents.Open(FileName=filepath, ConfirmConversions=False, ReadOnly=False)
            props = doc.CustomDocumentProperties
                
            try: props("Certimens_ID").Value = id_final
            except: props.Add("Certimens_ID", False, 4, id_final)
                
            doc.Saved = False 
            doc.Save()
            try: doc.Close(0) 
            except: pass
            succes = True
            
        except Exception:
            pass 
        finally:
            if word_app is not None:
                try: word_app.Quit(0) 
                except: pass
            pythoncom.CoUninitialize()
        if succes: break 

# ==========================================
# SERVEUR LOCAL (ÉCOUTE L'EXTENSION)
# ==========================================
class PluginHandler(BaseHTTPRequestHandler):
    def do_OPTIONS(self):
        self.send_response(200, "ok")
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'POST, OPTIONS')
        self.send_header("Access-Control-Allow-Headers", "X-Requested-With, Content-type")
        self.end_headers()

    def do_POST(self):
        global session_web_id
        try:
            content_length = int(self.headers['Content-Length'])
            post_data = self.rfile.read(content_length)
            data = json.loads(post_data.decode('utf-8'))
            
            if data.get("action") == "UPDATE_DOC_ID": 
                session_web_id = data.get("documentId")
            elif data.get("action") == "CLEAR_DOC_ID": 
                session_web_id = None
            elif data.get("action") == "TAG_DOWNLOAD":
                vider_memoire_tampon()
                doc_id = data.get("documentId")
                filepath = data.get("filepath")
                threading.Thread(target=injecter_uuid_google_doc, args=(filepath, doc_id), daemon=True).start()
                
            self.send_response(200)
            self.send_header('Access-Control-Allow-Origin', '*')
            self.end_headers()
        except Exception: pass
    def log_message(self, format, *args): return

def ecouter_navigateur():
    server = HTTPServer(('127.0.0.1', 14567), PluginHandler)
    server.timeout = 1
    while agent_running: server.handle_request()

# ==========================================
# SUPERVISEUR COM (TATOUAGE ET DISQUE)
# ==========================================
def superviseur_word_com():
    global last_char_count, last_hwnd_word, injections_detectees
    global word_session_uuid, word_is_ghost
    global was_word_focused, last_mtime
    
    pythoncom.CoInitialize()
    word_app = None
    try:
        while agent_running:
            time.sleep(1.0)
            if is_paused: continue
            try:
                if word_app is None: word_app = win32com.client.GetActiveObject("Word.Application")
                hwnd = win32gui.GetForegroundWindow()
                _, pid = win32process.GetWindowThreadProcessId(hwnd)
                try: p_name = psutil.Process(pid).name().lower()
                except: p_name = ""
                    
                if p_name == "winword.exe":
                    was_word_focused = True
                    if hwnd != last_hwnd_word:
                        last_char_count = -1
                        last_hwnd_word = hwnd
                        
                    doc = word_app.ActiveDocument
                    current_count = doc.ComputeStatistics(3) 
                    if last_char_count != -1:
                        delta = current_count - last_char_count
                        if delta > 50:
                            with data_lock:
                                injections_detectees.append({"volume_caracteres": delta, "timestamp": int(datetime.now(timezone.utc).timestamp())})
                    last_char_count = current_count
                    
                    if not doc.Path:
                        word_is_ghost = True
                        word_session_uuid = ""
                    else:
                        word_is_ghost = False
                        
                        # --- DÉTECTION SAUVEGARDE DISQUE (FLUSH) ---
                        try:
                            filepath = os.path.join(doc.Path, doc.Name)
                            mtime = os.path.getmtime(filepath)
                            if last_mtime > 0 and mtime > last_mtime:
                                vider_memoire_tampon()
                            last_mtime = mtime
                        except: pass
                        
                        props = doc.CustomDocumentProperties
                        try: word_session_uuid = props("Certimens_ID").Value
                        except:
                            word_session_uuid = str(uuid.uuid4())
                            props.Add("Certimens_ID", False, 4, word_session_uuid)
                            doc.Save()
                else: 
                    word_is_ghost = False
                    # --- DÉTECTION PERTE DE FOCUS (FLUSH) ---
                    if was_word_focused:
                        vider_memoire_tampon() 
                        was_word_focused = False
                        
            except Exception: word_app = None
    finally:
        pythoncom.CoUninitialize()

# ==========================================
# ONBOARDING & POP-UP
# ==========================================
def charger_config():
    global student_email
    if os.path.exists(CONFIG_FILE):
        with open(CONFIG_FILE, 'r') as f:
            student_email = json.load(f).get("email", "").strip().lower()
            return True
    return False

def afficher_onboarding():
    global student_email
    root = tk.Tk()
    root.title("Certimens - Configuration")
    root.geometry("450x320") 
    root.eval('tk::PlaceWindow . center')
    root.configure(bg="#f8f9fa")

    tk.Label(root, text="🛡️ Agent Certimens", font=("Helvetica", 16, "bold"), bg="#f8f9fa", fg="#1e293b").pack(pady=10)
    tk.Label(root, text="Veuillez saisir votre e-mail institutionnel :", bg="#f8f9fa", fg="#475569").pack()
    email_entry = tk.Entry(root, width=40, font=("Helvetica", 11))
    email_entry.pack(pady=5)

    def valider():
        email = email_entry.get().strip().lower()
        if not re.match(r'^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$', email):
            messagebox.showerror("Erreur", "Format invalide.")
            return
        with open(CONFIG_FILE, 'w') as f: json.dump({"email": email}, f)
        global student_email
        student_email = email
        root.destroy()

    tk.Button(root, text="Activer la protection", command=valider, bg="#c5a059", fg="white", font=("Helvetica", 10, "bold"), padx=20, pady=5).pack(pady=20)
    root.mainloop()

def afficher_popup_avertissement(hwnd):
    root = tk.Tk()
    root.overrideredirect(True)
    root.attributes("-topmost", True)
    root.configure(bg="#ffffff", highlightbackground="#c5a059", highlightthickness=2)
    w, h = 360, 150
    sw = root.winfo_screenwidth()
    sh = root.winfo_screenheight()
    root.geometry(f"{w}x{h}+{sw - w - 20}+{sh - h - 60}")
    tk.Label(root, text="🛡️ Bouclier Certimens", font=("Segoe UI", 12, "bold"), bg="#ffffff", fg="#c5a059").pack(pady=(15, 5))
    tk.Label(root, text="Ce brouillon n'est pas sauvegardé.\nFaites 'Enregistrer sous' pour activer la certification.", font=("Segoe UI", 9), bg="#ffffff", fg="#475569").pack(pady=5)
    def on_ignore():
        ignored_hwnds.add(hwnd)
        set_icon_state("synchro")
        root.destroy()
    def on_ok():
        popup_cooldowns[hwnd] = time.time() + 300 
        root.destroy()
    btn_frame = tk.Frame(root, bg="#ffffff")
    btn_frame.pack(pady=10)
    tk.Button(btn_frame, text="J'ai compris", command=on_ok, bg="#c5a059", fg="white", font=("Segoe UI", 9, "bold"), relief="flat", padx=10, pady=3).pack(side="left", padx=10)
    tk.Button(btn_frame, text="Ignorer", command=on_ignore, bg="#e2e8f0", fg="#475569", font=("Segoe UI", 9), relief="flat", padx=10, pady=3).pack(side="right", padx=10)
    root.after(15000, on_ok)
    root.mainloop()

# ==========================================
# WINDOWS API & MACHINE A ETATS
# ==========================================
def get_active_window_info():
    try:
        hwnd = win32gui.GetForegroundWindow()
        if hwnd == 0: return "UNKNOWN_UUID", "inconnu", "Bureau/Inconnu", 0
        if hwnd not in fenetres_connues: fenetres_connues[hwnd] = str(uuid.uuid4())
        session_id_immuable = fenetres_connues[hwnd]
        _, pid = win32process.GetWindowThreadProcessId(hwnd)
        try: p_name = psutil.Process(pid).name()
        except: p_name = "inconnu"
        length = ctypes.windll.user32.GetWindowTextLengthW(hwnd)
        buff = ctypes.create_unicode_buffer(length + 1)
        ctypes.windll.user32.GetWindowTextW(hwnd, buff, length + 1)
        return session_id_immuable, p_name, buff.value.strip() or "Fenêtre sans nom", hwnd
    except Exception: return "UNKNOWN_UUID", "inconnu", "inconnu", 0

def on_click(x, y, button, pressed):
    global sauts_navigation, is_navigating, mouse_clicked_recently, last_event_time
    current_time = time.time()
    
    if pressed and agent_running and not is_paused:
        with data_lock:
            sauts_navigation += 1
            is_navigating = True
            mouse_clicked_recently = True
            
            if last_event_time > 0:
                delay = current_time - last_event_time
                if 3.0 < delay <= 60.0:
                    global pauses_cognitives
                    pauses_cognitives += 1
            last_event_time = current_time

def on_press(key):
    global last_press_time, timestamp_debut
    global dernier_hwnd_cible, session_actuelle_id, nom_fenetre_actuelle
    global packet_active_time_ms, packet_keystrokes, last_activity_time, last_event_time
    global injections_detectees, flight_times
    global corrections_immediates, reformulations_differees, sauts_navigation, is_navigating
    global mouse_clicked_recently, macro_repentirs, pauses_cognitives

    if is_paused or not agent_running: return
    
    session_id_immuable, p_name, w_title_brut, hwnd = get_active_window_info()
    p_name = str(p_name).strip().lower() if p_name else ""
    w_title_lower = w_title_brut.lower()
    
    is_word = (p_name == "winword.exe")
    navigateurs_autorises = ["chrome.exe", "msedge.exe", "firefox.exe", "brave.exe", "opera.exe"]
    titre_valide = any(mot in w_title_lower for mot in ["google docs", "document sans titre", "microsoft word", "office", "document"])
    
    if is_word or (p_name in navigateurs_autorises and titre_valide):
        fallback_fantome = is_word and (re.match(r'^document\s*\d+', w_title_lower) or "sans titre" in w_title_lower)
        if (word_is_ghost or fallback_fantome) and hwnd not in ignored_hwnds:
            set_icon_state("attente") 
            if not mute_alerts and time.time() > popup_cooldowns.get(hwnd, 0):
                popup_cooldowns[hwnd] = time.time() + 300 
                threading.Thread(target=afficher_popup_avertissement, args=(hwnd,), daemon=True).start()
            return 
            
        if not is_paused: set_icon_state("synchro")

        try: k_id = key.char
        except AttributeError: k_id = str(key)
        
        current_time, current_utc = time.time(), int(datetime.now(timezone.utc).timestamp()) 
        titre_propre = re.sub(r'(?i)\s*-\s*(Microsoft Word|Word|Enregistré.*|Mozilla Firefox|Google Chrome|Microsoft Edge)$', '', w_title_brut).strip()

        with data_lock:
            if is_word and word_session_uuid:
                session_actuelle_id = word_session_uuid
            elif p_name in navigateurs_autorises and session_web_id:
                session_actuelle_id = f"GDOCS-{session_web_id}"
            else:
                session_actuelle_id = session_id_immuable

            dernier_hwnd_cible = hwnd
            nom_fenetre_actuelle = titre_propre

            if k_id in touches_enfoncees: return
            touches_enfoncees.add(k_id)

            if last_event_time > 0:
                delay_since_event = current_time - last_event_time
                if 3.0 < delay_since_event <= 60.0:
                    pauses_cognitives += 1
            last_event_time = current_time

            if last_press_time > 0:
                delay = (current_time - last_press_time) * 1000
                if delay < 800:
                    flight_times.append(delay)
                    if len(flight_times) > 100: flight_times.pop(0)
            last_press_time = current_time

            if key == keyboard.Key.backspace or key == keyboard.Key.delete:
                if mouse_clicked_recently:
                    macro_repentirs += 1 
                elif is_navigating:
                    reformulations_differees += 1 
                else:
                    corrections_immediates += 1 
            elif key in [keyboard.Key.left, keyboard.Key.right, keyboard.Key.up, keyboard.Key.down]:
                sauts_navigation += 1
                is_navigating = True
            else:
                if type(key) == keyboard.Key and key in [keyboard.Key.shift, keyboard.Key.shift_r, keyboard.Key.ctrl, keyboard.Key.ctrl_l, keyboard.Key.ctrl_r, keyboard.Key.alt, keyboard.Key.alt_gr, keyboard.Key.cmd]:
                    pass
                else:
                    is_navigating = False
            
            mouse_clicked_recently = False 

            is_ctrl_pressed = any(k in touches_enfoncees for k in ['Key.ctrl_l', 'Key.ctrl_r', 'Key.ctrl'])
            
            if is_ctrl_pressed and k_id in ['x', 'X', '\x18']:
                macro_repentirs += 1
                
            if is_ctrl_pressed and k_id in ['z', 'Z', '\x1a']: 
                corrections_immediates += 1
                
            if is_ctrl_pressed and k_id in ['s', 'S', '\x13']:
                threading.Thread(target=vider_memoire_tampon, daemon=True).start()
                
            if is_ctrl_pressed and k_id in ['v', 'V', '\x16']:
                try:
                    win32clipboard.OpenClipboard()
                    texte = win32clipboard.GetClipboardData(win32clipboard.CF_UNICODETEXT)
                    win32clipboard.CloseClipboard()
                    if texte and len(texte) > 15: injections_detectees.append({"volume_caracteres": len(texte), "timestamp": current_utc})
                except: pass
            
            if timestamp_debut is None: timestamp_debut = current_utc
            if last_activity_time > 0:
                delay_activity = current_time - last_activity_time
                if delay_activity <= 2.0:
                    packet_active_time_ms += (delay_activity * 1000)
                elif delay_activity < 60.0:
                    packet_active_time_ms += 250
            
            last_activity_time = current_time
            packet_keystrokes += 1
            
            if packet_keystrokes >= 200:
                vider_memoire_tampon() 

def on_release(key):
    if is_paused or not agent_running: return
    try: k_id = key.char
    except AttributeError: k_id = str(key)
    with data_lock:
        if k_id in touches_enfoncees: touches_enfoncees.remove(k_id)

# ==========================================
# RÉSEAU & SYNCHRONISATION
# ==========================================
def envoyer_donnees(nouveau_paquet):
    cache = []
    if os.path.exists(CACHE_FILE):
        try:
            with open(CACHE_FILE, 'r') as f: cache = json.load(f)
        except: pass
    if nouveau_paquet: cache.append(nouveau_paquet)
    if not cache: return True

    paquets_restants, succes_total = [], True
    for p in cache:
        try:
            req = urllib.request.Request(URL_SERVEUR, data=json.dumps(p).encode('utf-8')) 
            req.add_header('Content-Type', 'application/json')
            req.add_header('X-Certimens-Auth', CLE_SECURITE) 
            urllib.request.urlopen(req)
        except Exception:
            paquets_restants.append(p)
            succes_total = False

    if paquets_restants:
        with open(CACHE_FILE, 'w') as f: json.dump(paquets_restants, f)
    elif os.path.exists(CACHE_FILE): os.remove(CACHE_FILE)
    return succes_total

# ==========================================
# INTERFACE BARRE DES TÂCHES
# ==========================================
def create_image(etat="synchro"):
    couleur_fond = (41, 128, 185) 
    if etat == "pause": couleur_fond = (127, 140, 141) 
    image = Image.new('RGB', (64, 64), color=couleur_fond)
    draw = ImageDraw.Draw(image)
    draw.ellipse((16, 16, 48, 48), fill=(255, 255, 255))
    if etat == "attente": draw.ellipse((44, 44, 64, 64), fill=(243, 156, 18)) 
    elif etat == "synchro" and not is_paused: draw.ellipse((44, 44, 64, 64), fill=(46, 204, 113)) 
    return image

def set_icon_state(etat):
    global global_icon
    if global_icon: global_icon.icon = create_image(etat)

def action_toggle_pause(icon, item):
    global is_paused, packet_keystrokes, corrections_immediates, reformulations_differees
    global sauts_navigation, macro_repentirs, pauses_cognitives
    is_paused = not is_paused
    if is_paused:
        with data_lock:
            packet_keystrokes, corrections_immediates, reformulations_differees = 0, 0, 0
            sauts_navigation, macro_repentirs, pauses_cognitives = 0, 0, 0
    set_icon_state("pause" if is_paused else "synchro")
    icon.update_menu()

def action_toggle_mute(icon, item):
    global mute_alerts
    mute_alerts = not mute_alerts
    icon.update_menu()

# NOUVEAU : REDÉMARRAGE DOUX (GRACEFUL RESTART)
def action_redemarrer(icon, item):
    global agent_running
    vider_memoire_tampon() # Sauvetage des données avant la coupure
    agent_running = False
    icon.stop()
    os.execl(sys.executable, sys.executable, *sys.argv)

def action_quitter(icon, item):
    global agent_running
    agent_running = False
    icon.stop()

# ==========================================
# DÉMARRAGE
# ==========================================
if __name__ == "__main__":
    if not charger_config(): afficher_onboarding()
    if not student_email: sys.exit()
        
    threading.Thread(target=superviseur_word_com, daemon=True).start()
    threading.Thread(target=ecouter_navigateur, daemon=True).start() 
    
    listener_mouse = mouse.Listener(on_click=on_click)
    listener_mouse.start()

    with keyboard.Listener(on_press=on_press, on_release=on_release) as listener_keyboard:
        menu = pystray.Menu(
            item(lambda text: "🔴 En pause" if is_paused else "🟢 Actif", lambda: None, enabled=False),
            pystray.MenuItem("---", None),
            item(lambda text: "▶️ Réactiver l'Agent" if is_paused else "⏸️ Mettre en pause", action_toggle_pause),
            item("🔄 Actualiser l'Agent", action_redemarrer),
            item(lambda text: "🔔 Activer les alertes" if mute_alerts else "🔕 Couper les alertes", action_toggle_mute),
            pystray.MenuItem("---", None),
            item("❌ Quitter Certimens", action_quitter)
        )
        global_icon = pystray.Icon("Certimens", create_image("synchro"), "Agent Certimens", menu)
        threading.Thread(target=global_icon.run, daemon=True).start()
        listener_keyboard.join()
        listener_mouse.join()
