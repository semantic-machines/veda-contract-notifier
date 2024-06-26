import VedaService from './VedaService.js';
import {BaseModel} from 'veda-client';
import Mustache from 'mustache';
import log from './log.js';
import {Responsible, Responsibility} from './ResponsiblePerson.js';
import ResponsibleList from './ResponsibleList.js';

export default class ContractNotifier {
  constructor (options) {
    this.options = options;
  }

  async init () {
    this.veda = new VedaService(this.options);
    await this.veda.init();
  }

  async getContractsFromStoredQuery () {
    try {
      return await this.veda.getDocsFromStoredQuery();
    } catch (error) {
      log.error(`Failed to query data: ${error.message}`);
    }
  }

  async getResponsiblePerson (contractUri) {
    const contract = new BaseModel(contractUri);
    try {
      await contract.load();
    } catch (error) {
      log.error(contractUri, error.message);
      throw error;
    }

    // contract responsibles properties
    const executorPropUri = 'mnd-s:executorSpecialistOfContract';
    const supporterPropUri = 'mnd-s:supportSpecialistOfContract';
    const managerPropUri = 'mnd-s:ContractManager';
    const depPropUri = 'v-s:responsibleDepartment';
    const controllerRespType = 'controller';

    const isExecutorValid = await this.isContractResponsibleValid(contract, executorPropUri)
      .catch((error) => {
        log.error(`Failed to check isExecutorValid: ${error.message}`);
        return false;
      });
    const isSupporterValid = await this.isContractResponsibleValid(contract, supporterPropUri)
      .catch((error) => {
        log.error(`Failed to check isSupporterValid: ${error.message}`);
        return false;
      });
    const isManagerValid = await this.isContractResponsibleValid(contract, managerPropUri)
      .catch((error) => {
        log.error(`Failed to check isManagerValid: ${error.message}`);
        return false;
      });
    const isDepValid = await this.isContractResponsibleValid(contract, depPropUri)
      .catch((error) => {
        log.error(`Failed to check isDepValid: ${error.message}`);
        return false;
      });

    if (!isExecutorValid) {
      // calculate responsible if executor unvalid
      if (contract.hasValue(depPropUri)) {
        try {
          const responsibleDep = contract[depPropUri][0];
          await responsibleDep.load();

          // if not UZ responsible == controller
          if (! await this.veda.isSubUnitOf(responsibleDep, 'd:mondi_department_50001663')) {
            log.info(contractUri, 'contract not from UZ. Send it to controller');
            return new Responsible('d:contract_controller_role', new Responsibility('controller-not-uz', contractUri));
          }
          if (! await this.veda.isIndividValid(responsibleDep)) {
            return new Responsible('d:contract_controller_role', new Responsibility(controllerRespType, contractUri));
          }

          const depChief = await this.veda.getChiefDetailUri(responsibleDep);
          if (depChief) {
            const depChiefObj = new BaseModel(depChief);
            if (await this.veda.isIndividValid(depChiefObj)) {
              return new Responsible(depChief, new Responsibility(depPropUri, contractUri));
            }
          }
        } catch (error) {
          log.error(`Failed to handle responsibleDep: ${error.message}`);
        }
      }
      return new Responsible('d:contract_controller_role', new Responsibility(controllerRespType, contractUri));
    }
    if (!isSupporterValid || !isManagerValid || !isDepValid) {
      return new Responsible(contract[executorPropUri][0].id, new Responsibility(executorPropUri, contractUri));
    }
    return new Responsible('d:contract_controller_role', new Responsibility(controllerRespType, contractUri));
  }

  async isContractResponsibleValid (contract, responsibleProp) {
    try {
      if (contract.hasValue(responsibleProp)) {
        const responsible = contract[responsibleProp][0];
        await responsible.load();
        return await this.veda.isIndividValid(responsible);
      }
      return false;
    } catch (error) {
      log.error(`Failed to validate contract responsible: ${error}`);
      throw error;
    }
  }

  async getResponsiblesList (contractsUri) {
    const error_uris = [];
    const responsibleList = new ResponsibleList();
    for (let i = 0; i < contractsUri.length; i++) {
      try {
        const responsible = await this.getResponsiblePerson(contractsUri[i]);
        responsibleList.addResponsible(responsible);
      } catch (error) {
        log.error(`Cant calculate person to notify CONTRACT: ${contractsUri[i]}, send it to controller`);
        error_uris.push(contractsUri[i]);
        responsibleList.addResponsible(new Responsible('d:contract_controller_role', new Responsibility('controller', contractsUri[i])));
        continue;
      }
      log.info(`Get responsible for: ${contractsUri[i]}`);
    }
    if (error_uris != []) {
      log.error('Cant find responsible for this contracts, send it to controller:', error_uris.join('\n'));
    }

    return responsibleList;
  }

  async sendMail (responsible) {
    const contracts = await Promise.all(responsible.documents.map(async (item) => {
      const regNumber = await this.getContractProp(item, 'v-s:registrationNumber');
      // const respDep = await this.getContractProp(item, 'v-s:responsibleDepartment');
      // const exec = await this.getContractProp(item, 'mnd-s:executorSpecialistOfContract');
      return [regNumber, `${this.options.veda.server}#/${item}`].map((result) => {
        if (result == undefined) {
          return 'не определено';
        }
        return result;
      }).join(' - ');
    }));
    const view = {
      app_name: 'Optiflow',
      contract_list: contracts.join('\n'),
    };
    const letter = await this.getMailLetterByRespType(responsible.type);
    letter.subject = Mustache.render(letter.subject, view).replace(/&#x2F;/g, '/');
    letter.body = Mustache.render(letter.body, view).replace(/&#x2F;/g, '/');

    const mailObj = this.veda.prepareEmailLetter(responsible.id, letter);
    // await mailObj.save();
    log.info(`Mail send to: ${responsible.id}. Email obj uri: ${mailObj.id}`);
    log.info(mailObj['v-s:messageBody']);
  }

  async getContractProp (contractUri, prop) {
    try {
      const contract = new BaseModel(contractUri);
      await contract.load();
      if (contract.hasValue(prop)) {
        const val = contract[prop][0];
        // if (val instanceof BaseModel) {
        //   await val.load();
        //   return val.toJSON()['rdfs:label'][0].data;
        // }
        return val;
      }
    } catch (e) {
      log.error(e.message, 'cant get', prop);
    }
  }

  async getMailLetterByRespType (type) {
    try {
      if (type === 'mnd-s:executorSpecialistOfContract') {
        return await this.veda.getMailLetterView(this.options.veda.mail.template + '-for-executor');
      }
      if (type === 'v-s:responsibleDepartment') {
        return await this.veda.getMailLetterView(this.options.veda.mail.template + '-for-dep-chief');
      }
      if (type === 'controller') {
        return await this.veda.getMailLetterView(this.options.veda.mail.template + '-for-dep-controller');
      }
      if (type === 'controller-not-uz') {
        return await this.veda.getMailLetterView(this.options.veda.mail.template + '-controller-not-uz');
      }
    } catch (e) {
      log.error('Cant get message template. Error message: ', e.message);
    }
  }
}
