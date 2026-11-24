require "json"
require "pathname"
require "yaml"

root = Pathname.new(Dir.pwd)
source = Pathname.new(ARGV.fetch(0)).realpath
hosted = source / "hosted"
catalog_path = Pathname.new("packages/release-catalog/package.json")
public_catalog = JSON.parse((root / catalog_path).read)
private_catalog = JSON.parse((hosted / catalog_path).read)
private_packages = (source / "packages").children.select do |path|
  (path / "package.json").file?
end
private_names = private_packages.map do |path|
  JSON.parse((path / "package.json").read).fetch("name")
end
private_paths = private_packages.map { |path| "packages/#{path.basename}" }
private_dependencies = private_catalog.fetch("dependencies").slice(*private_names)
abort "First-party release catalog has no dependencies" if private_dependencies.empty?

# Keep the public revisions of every shared dependency. Private workspace
# importers and their pinned package resolutions come from the private lock.
load_lock = ->(path) { YAML.safe_load(path.read) }
public_lock = load_lock.call(root / "pnpm-lock.yaml")
private_lock = load_lock.call(hosted / "pnpm-lock.yaml")
abort "Incompatible workspace lockfile versions" unless
  public_lock.fetch("lockfileVersion") == private_lock.fetch("lockfileVersion")
private_importers = private_lock.fetch("importers")
imports = public_lock.fetch("importers")
private_paths.each do |path|
  value = private_importers.fetch(path)
  abort "Unexpected public workspace package: #{path}" if imports.key?(path)
  imports[path] = value
end
catalog_importer = catalog_path.dirname.to_s
imports.fetch(catalog_importer).fetch("dependencies").merge!(
  private_importers.fetch(catalog_importer).fetch("dependencies").slice(*private_dependencies.keys)
)
%w[packages snapshots].each do |section|
  public_lock[section] = private_lock.fetch(section).merge(public_lock.fetch(section))
end
public_catalog.fetch("dependencies").merge!(private_dependencies)
(root / catalog_path).write(JSON.pretty_generate(public_catalog) + "\n")
(root / "pnpm-lock.yaml").write(YAML.dump(public_lock).delete_prefix("---\n"))
