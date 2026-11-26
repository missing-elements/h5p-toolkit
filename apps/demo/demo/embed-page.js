/**
 * The demo's `/embed`: the page `@missing-elements/h5p-embed` writes for a player domain, with the
 * demo's own library pack, the one `libraries=pack` names. One script for both: it shows what a host deploys.
 */

import '@missing-elements/h5p-embed/embed.css'
import { startEmbed } from '@missing-elements/h5p-embed/embed.js'
import { pack } from '@missing-elements/h5p-libraries'

startEmbed({ pack })
