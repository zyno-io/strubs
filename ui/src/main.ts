import '@fontsource/inter/latin-400.css'
import '@fontsource/inter/latin-500.css'
import '@fontsource/inter/latin-600.css'
import '@fontsource/inter/latin-700.css'
import '@fortawesome/fontawesome-free/css/fontawesome.css'
import '@fortawesome/fontawesome-free/css/solid.css'
import './styles/base.scss'
import './styles/strubs.scss'
import './composables/useTheme'
import { createApp } from 'vue'
import App from './App.vue'

createApp(App).mount('#app')
