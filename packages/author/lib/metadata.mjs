/**
 * H5P's metadata as the platforms take it (`getMetadataSemantics`): licences, versions, authors'
 * roles. A licence the copyright dialog cannot name ends it, so saved metadata is held to them.
 */

/** The licences H5P's metadata takes. */
export const LICENSES = ['U', 'CC BY', 'CC BY-SA', 'CC BY-ND', 'CC BY-NC', 'CC BY-NC-SA', 'CC BY-NC-ND', 'CC0 1.0', 'CC PDM', 'GNU GPL', 'PD', 'ODC PDDL', 'C']
export const CC_VERSIONS = ['4.0', '3.0', '2.5', '2.0', '1.0']
export const ROLES = ['Author', 'Editor', 'Licensee', 'Originator']

/** @param {unknown} value @returns {value is Record<string, any>} */
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)

/**
 * Saved sub-content's metadata, held to what the core reads: a title of at most 255 characters, a
 * licence and version H5P names, authors in its roles. The rest is kept as saved.
 * @param {unknown} metadata
 * @param {string} path where it sits, for problems
 * @param {(path: string, message: string) => void} report
 */
export function checkMetadata(metadata, path, report) {
  if (!isObject(metadata)) {
    report(path, 'expected an object, such as { "title": "…", "license": "U" }')
    return
  }
  const { title, license, licenseVersion, authors } = metadata
  if (title !== undefined && typeof title !== 'string') report(`${path}.title`, 'expected a title')
  else if (typeof title === 'string' && title.length > 255) report(`${path}.title`, 'takes at most 255 characters')
  if (license !== undefined && !LICENSES.includes(license)) report(`${path}.license`, `use one of ${LICENSES.map((each) => JSON.stringify(each)).join(', ')}`)
  if (licenseVersion !== undefined && !CC_VERSIONS.includes(licenseVersion)) report(`${path}.licenseVersion`, `use one of ${CC_VERSIONS.join(', ')}`)
  if (authors === undefined) return
  if (!Array.isArray(authors)) report(`${path}.authors`, 'expected a list, [{ "name": "…", "role": "Author" }]')
  else authors.forEach((/** @type {unknown} */ author, /** @type {number} */ i) => {
    if (!isObject(author)) report(`${path}.authors[${i}]`, 'expected an author, { "name": "…", "role": "Author" }')
    else if (author.role !== undefined && !ROLES.includes(author.role)) report(`${path}.authors[${i}].role`, `use one of ${ROLES.join(', ')}`)
    else if (author.name !== undefined && typeof author.name !== 'string') report(`${path}.authors[${i}].name`, 'expected the author\'s name')
  })
}
