// A module served by the UI test site, in the layout of a CDN, to import by
// name with import() when the magic imports are pointed at the test site.
export function greet(name) {
  return `Hello, ${name}!`;
}
export default 'imports fixture';
