/**
 * The package as a `node16`/`nodenext` caller sees it, by name through `exports`' `types`; checked
 * by `pnpm typecheck`, nothing runs. A source import without `.js` leaves its types `any` (#60).
 */
import { H5PPlayerElement, type PackageMetadata, type PlayerErrorDetail, type ReadyDetail } from '@missing-elements/h5p-offline-player'
import { mountH5P } from '@missing-elements/h5p-offline-player/sw'
import { librariesNamedIn, ownLibraries, packLibrariesIn, planPack, reachableFolder, walkDependencies, type PackPlan } from '@missing-elements/h5p-offline-player/plan'

export function asACallerWould(worker: ServiceWorkerGlobalScope): string[] {
  const player: H5PPlayerElement | null = document.querySelector('h5p-player')
  mountH5P(worker, { scope: '/h5p/' })

  // The library rules, as h5p-author runs them.
  const roots = librariesNamedIn({ library: 'H5P.Blanks 1.14' }).map(({ machineName, majorVersion, minorVersion }) => ({ machineName, majorVersion: Number(majorVersion), minorVersion: Number(minorVersion) }))
  const plan: PackPlan | null = planPack({ own: [], provided: [], roots, params: {}, pack: [], refresh: false, fill: true })
  // @ts-expect-error the parts are a list
  const parts: PackPlan['parts'] = 'H5P.Blanks-1.14'
  // The folder rule and the walk, as embed's SCORM writer runs them over a zip.
  const names = new Set(['H5P.Blanks-1.14/library.json'])
  const folder: string | undefined = reachableFolder(roots[0], names, new Map())
  const walked: Promise<{ missing: { machineName: string }[] }> = walkDependencies(roots, (dependency) => reachableFolder(dependency, names, new Map()), async (located: string) => ({ located }))
  const own: Promise<{ folder: string; major: number | null }[]> = ownLibraries(['H5P.Blanks-1.14'])
  // A pack's index read from the network, held to its shape, as h5p-author's page build reads one.
  const index: { folder: string; url: string; sha256: string }[] = packLibrariesIn(JSON.parse('[]'))

  // @ts-expect-error not an error code
  const code: PlayerErrorDetail['code'] = 'offline'
  // @ts-expect-error the folders are a list
  const folders: NonNullable<PlayerErrorDetail['missingLibraries']>['folders'] = 'H5P.Column-1.18'
  // @ts-expect-error not a kind of source
  const source: NonNullable<ReadyDetail['source']>['type'] = 'ftp'
  // @ts-expect-error the title is a string
  const title: PackageMetadata['title'] = 1

  void [player, code, folders, source, title, plan, parts, folder, walked, own, index]
  return player?.libraryBundle?.refreshed?.map(({ library, to }) => `${library} ${to}`) ?? []
}
