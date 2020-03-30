const path = require('path')
const { mkdir } = require('fs-extra')
const chalk = require('chalk')
const inquirer = require('@serverless/inquirer')
const confirm = require('@serverless/inquirer/utils/confirm')
const { isProjectPath } = require('../utils')

const isValidProjectName = RegExp.prototype.test.bind(/^[a-zA-Z][a-zA-Z0-9-]{0,100}$/)

// TODO: Fill with valid, prepared app choices
const initializeProjectChoices = [
  { name: 'Express.js App', value: 'express' },
  { name: 'Koa App', value: 'koa' },
  { name: 'Other', value: 'other' }
]

const projectTypeChoice = async () =>
  (
    await inquirer.prompt({
      // EN: What do you want to make?
      message: '请选择你希望创建的 Serverless 应用',
      type: 'list',
      name: 'projectType',
      choices: initializeProjectChoices
    })
  ).projectType

const projectNameInput = async (workingDir) =>
  (
    await inquirer.prompt({
      // EN: What do you want to call this project?
      message: '请输入项目名称',
      type: 'input',
      name: 'projectName',
      validate: async (input) => {
        input = input.trim()
        if (!isValidProjectName(input)) {
          return (
            // EN: Project name is not valid:
            '项目名称校验失败:\n' +
            // EN: - It should only contain alphanumeric and hyphens
            '   项目名称只能包含字母和连字符；\n' +
            // EN: - It should start with an alphabetic character
            '   并且需要以字母开头；\n' +
            // EN: - Shouldn't exceed 128 characters
            '   项目名称不超过 128 个字符。'
          )
        }
        const projectPath = path.join(workingDir, input)
        return (await isProjectPath(projectPath))
          ? // EN: Serverless project already found at ${input} directory
            `您的 ${input} 目录中已经存在 Serverless 项目`
          : true
      }
    })
  ).projectName.trim()

const createProject = async (projectType, projectDir) => {
  await mkdir(projectDir)
  // TODO: Download component and install
}

module.exports = async () => {
  // We assume we're not in service|component context
  // As this function is configured to be invoked only in such case
  if (
    // EN: No project detected. Do you want to create a new one?'
    !(await confirm('当前未检测到 Serverless 项目，是否希望新建一个项目？', {
      name: 'shouldCreateNewProject'
    }))
  ) {
    return
  }

  const projectType = await projectTypeChoice()
  if (projectType === 'other') {
    // TODO: Provide wanted message
    // EN: Check http://???? to view available components.
    process.stdout.write('\n访问 http://???? 地址查看可用的组件。\n')
    return null
  }
  const workingDir = process.cwd()
  const projectName = await projectNameInput(workingDir)
  const projectDir = path.join(workingDir, projectName)
  await createProject(projectType, projectDir)
  // EN: Project successfully created in '${projectName}' folder
  process.stdout.write(`\n${chalk.green(`${projectName} 项目已成功创建！`)}\n`)

  process.chdir(projectDir)

  if (
    // EN: Do you want to deploy your project on the cloud now?
    !(await confirm('是否希望立即将该项目部署到云端？', {
      name: 'shouldDeployNewProject'
    }))
  ) {
    return
  }

  // Proceed with a deployment
  process.argv.push('deploy')
  return require('..')
}
