import { computed, ref } from 'vue';

export type ThemeMode = 'system' | 'light' | 'dark';

const STORAGE_KEY = 'strubs:theme';
const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');

function readStoredMode(): ThemeMode {
    try {
        const stored = localStorage.getItem(STORAGE_KEY);
        return stored === 'light' || stored === 'dark' ? stored : 'system';
    } catch {
        return 'system';
    }
}

const mode = ref<ThemeMode>(readStoredMode());
const systemDark = ref(mediaQuery.matches);
const isDark = computed(() => mode.value === 'dark' || (mode.value === 'system' && systemDark.value));

function apply() {
    document.documentElement.classList.toggle('dark', isDark.value);
}

mediaQuery.addEventListener('change', e => {
    systemDark.value = e.matches;
    apply();
});

// other tabs changing the preference
window.addEventListener('storage', e => {
    if (e.key === STORAGE_KEY) {
        mode.value = readStoredMode();
        apply();
    }
});

function setMode(next: ThemeMode) {
    mode.value = next;
    try {
        if (next === 'system') localStorage.removeItem(STORAGE_KEY);
        else localStorage.setItem(STORAGE_KEY, next);
    } catch {
        // storage unavailable; the choice still applies for this page
    }
    apply();
}

apply();

export function useTheme() {
    return { mode, isDark, setMode };
}
