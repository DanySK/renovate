import { join } from 'upath';
import * as datasourceSbtPackage from '../../../datasource/sbt-package';
import { logger } from '../../../logger';
import {
  localPathExists,
  readLocalFile,
  writeLocalFile,
} from '../../../util/fs';
import { regEx } from '../../../util/regex';
import type {
  BuildDependency,
  GradleDependencyWithRepos,
  GradleProject,
} from './types';

export const GRADLE_DEPENDENCY_REPORT_FILENAME = 'gradle-renovate-report.json';

export async function createRenovateGradlePlugin(
  gradleRoot = '.'
): Promise<void> {
  const content = `
import groovy.json.JsonOutput
import org.gradle.api.internal.artifacts.dependencies.DefaultExternalModuleDependency
import java.util.concurrent.ConcurrentLinkedQueue

def output = new ConcurrentLinkedQueue<>();

allprojects {
  tasks.register("renovate") {
    doLast {
      def project = ['project': project.name]
      output << project

      def repos = (repositories + buildscript.repositories + settings.pluginManagement.repositories)
        .findAll { it instanceof MavenArtifactRepository && it.url.scheme ==~ /https?/ }
        .collect { "$it.url" }
        .unique()
      project.repositories = repos

      def deps = (buildscript.configurations + configurations + settings.buildscript.configurations)
        .collect { it.dependencies + it.dependencyConstraints }
        .flatten()
        .findAll { it instanceof DefaultExternalModuleDependency || it instanceof DependencyConstraint }
        .findAll { 'Pinned to the embedded Kotlin' != it.reason } // Embedded Kotlin dependencies
        .collect { ['name':it.name, 'group':it.group, 'version':it.version] }
      project.dependencies = deps
    }
  }
}
gradle.buildFinished {
   def outputFile = new File('${GRADLE_DEPENDENCY_REPORT_FILENAME}')
   def json = JsonOutput.toJson(output)
   outputFile.write json
}`;
  const gradleInitFile = join(gradleRoot, 'renovate-plugin.gradle');
  logger.debug(
    'Creating renovate-plugin.gradle file with renovate gradle plugin'
  );
  await writeLocalFile(gradleInitFile, content);
}

async function readGradleReport(localDir: string): Promise<GradleProject[]> {
  const renovateReportFilename = join(
    localDir,
    GRADLE_DEPENDENCY_REPORT_FILENAME
  );
  if (!(await localPathExists(renovateReportFilename))) {
    return [];
  }

  const contents = await readLocalFile(renovateReportFilename, 'utf8');
  try {
    return JSON.parse(contents);
  } catch (err) {
    logger.error({ err }, 'Invalid Gradle extract JSON');
    return [];
  }
}

function mergeDependenciesWithRepositories(
  project: GradleProject
): GradleDependencyWithRepos[] {
  if (!project.dependencies) {
    return [];
  }
  return project.dependencies.map((dep) => ({
    ...dep,
    repos: [...project.repositories],
  }));
}

function flattenDependencies(
  accumulator: GradleDependencyWithRepos[],
  currentValue: GradleDependencyWithRepos[]
): GradleDependencyWithRepos[] {
  accumulator.push(...currentValue);
  return accumulator;
}

function combineReposOnDuplicatedDependencies(
  accumulator: GradleDependencyWithRepos[],
  currentValue: GradleDependencyWithRepos
): GradleDependencyWithRepos[] {
  const existingDependency = accumulator.find(
    (dep) => dep.name === currentValue.name && dep.group === currentValue.group
  );
  if (existingDependency) {
    const nonExistingRepos = currentValue.repos.filter(
      (repo) => !existingDependency.repos.includes(repo)
    );
    existingDependency.repos.push(...nonExistingRepos);
  } else {
    accumulator.push(currentValue);
  }
  return accumulator;
}

function buildDependency(
  gradleModule: GradleDependencyWithRepos
): BuildDependency {
  return {
    name: gradleModule.name,
    depGroup: gradleModule.group,
    depName: `${gradleModule.group}:${gradleModule.name}`,
    currentValue: gradleModule.version,
    registryUrls: gradleModule.repos,
  };
}

export async function extractDependenciesFromUpdatesReport(
  localDir: string
): Promise<BuildDependency[]> {
  const gradleProjectConfigurations = await readGradleReport(localDir);

  const dependencies = gradleProjectConfigurations
    .map(mergeDependenciesWithRepositories, [])
    .reduce(flattenDependencies, [])
    .reduce(combineReposOnDuplicatedDependencies, []);

  return dependencies
    .map((gradleModule) => buildDependency(gradleModule))
    .map((dep) => {
      /* https://github.com/renovatebot/renovate/issues/4627 */
      const { depName, currentValue } = dep;
      if (depName.endsWith('_%%')) {
        return {
          ...dep,
          depName: depName.replace(regEx(/_%%/), ''), // TODO #12071
          datasource: datasourceSbtPackage.id,
        };
      }
      if (regEx(/^%.*%$/).test(currentValue)) {
        // TODO #12071
        return { ...dep, skipReason: 'version-placeholder' };
      }
      return dep;
    });
}
