import type { MessageCatalog } from "@/i18n/core";

export const tenantSettingsMessages = {
  "The temporary password must contain 12 to 128 characters.": [
    "La contraseña temporal debe tener entre 12 y 128 caracteres.",
    "The temporary password must contain 12 to 128 characters.",
    "A senha temporária deve ter entre 12 e 128 caracteres.",
  ],
  "Select the existing user to transfer.": [
    "Selecciona el usuario existente que quieres transferir.",
    "Select the existing user to transfer.",
    "Selecione o usuário existente que deseja transferir.",
  ],
  "This user is unavailable. Choose another active user.": [
    "Este usuario ya no está disponible. Selecciona otro usuario activo.",
    "This user is unavailable. Choose another active user.",
    "Este usuário está indisponível. Selecione outro usuário ativo.",
  ],
  "An operation is in progress for the user's current tenant. Wait for it to finish before trying again.":
    [
      "Hay una operación en curso en el tenant actual de este usuario. Espera a que termine antes de volver a intentarlo.",
      "An operation is in progress for the user's current tenant. Wait for it to finish before trying again.",
      "Há uma operação em andamento no tenant atual deste usuário. Aguarde a conclusão antes de tentar novamente.",
    ],
  "Another access change is in progress for this user. Wait for it to finish before trying again.":
    [
      "Hay otro cambio de acceso en curso para este usuario. Espera a que termine antes de volver a intentarlo.",
      "Another access change is in progress for this user. Wait for it to finish before trying again.",
      "Há outra alteração de acesso em andamento para este usuário. Aguarde a conclusão antes de tentar novamente.",
    ],
  "This user is the last active member of their organization. Add another member there before transferring them.":
    [
      "El usuario es el último miembro activo de su organización. Agrega otro miembro allí antes de transferirlo.",
      "This user is the last active member of their organization. Add another member there before transferring them.",
      "Este usuário é o último membro ativo da organização. Adicione outro membro à organização antes de transferi-lo.",
    ],
  "This user is a platform administrator. Revoke that role before transferring them.":
    [
      "El usuario es administrador de plataforma. Revoca ese rol antes de transferirlo.",
      "This user is a platform administrator. Revoke that role before transferring them.",
      "Este usuário é um administrador da plataforma. Revogue essa função antes de transferi-lo.",
    ],
  "The password setup email could not be sent. Use a temporary password or check email delivery.":
    [
      "No se pudo enviar el correo para configurar la contraseña. Usa una contraseña temporal o revisa el servicio de correo.",
      "The password setup email could not be sent. Use a temporary password or check email delivery.",
      "Não foi possível enviar o e-mail para definir a senha. Use uma senha temporária ou verifique o serviço de e-mail.",
    ],
  "Verification email could not be sent. Check email delivery and try again.": [
    "No se pudo enviar el correo de verificación. Revisa el servicio de correo e inténtalo de nuevo.",
    "Verification email could not be sent. Check email delivery and try again.",
    "Não foi possível enviar o e-mail de verificação. Verifique o serviço de e-mail e tente novamente.",
  ],
  "An account already uses this email. Choose an existing user or use a different email.":
    [
      "Ya existe una cuenta con ese correo. Selecciona un usuario existente o usa otro correo.",
      "An account already uses this email. Choose an existing user or use a different email.",
      "Já existe uma conta com esse e-mail. Selecione um usuário existente ou use outro e-mail.",
    ],
  "Savia could not confirm the tenant creation. Check the tenant list before trying again.":
    [
      "No se pudo confirmar la creación del tenant. Revisa la lista antes de volver a intentarlo.",
      "Savia could not confirm the tenant creation. Check the tenant list before trying again.",
      "O Savia não conseguiu confirmar a criação do tenant. Verifique a lista antes de tentar novamente.",
    ],
  "View tenants in a new tab": [
    "Ver tenants en otra pestaña",
    "View tenants in a new tab",
    "Ver tenants em outra aba",
  ],
  "Could not create the tenant. Review the information and try again.": [
    "No se pudo crear el tenant. Revisa los datos e inténtalo de nuevo.",
    "Could not create the tenant. Review the information and try again.",
    "Não foi possível criar o tenant. Revise os dados e tente novamente.",
  ],
  "Could not save the tenant. Review the information and try again.": [
    "No se pudo guardar el tenant. Revisa los datos e inténtalo de nuevo.",
    "Could not save the tenant. Review the information and try again.",
    "Não foi possível salvar o tenant. Revise os dados e tente novamente.",
  ],
  "Savia could not confirm the save. Open the tenant in another tab to check the changes before retrying.":
    [
      "No se pudo confirmar el guardado. Abre el tenant en otra pestaña para comprobar los cambios antes de reintentar.",
      "Savia could not confirm the save. Open the tenant in another tab to check the changes before retrying.",
      "O Savia não conseguiu confirmar o salvamento. Abra o tenant em outra aba para conferir as alterações antes de tentar novamente.",
    ],
  "Tenant settings": [
    "Configuración del tenant",
    "Tenant settings",
    "Configurações do tenant",
  ],
  "This is Savia’s internal workspace. Its general settings are read-only.": [
    "Este es el espacio interno de Savia. Su configuración general es de solo lectura.",
    "This is Savia’s internal workspace. Its general settings are read-only.",
    "Este é o espaço interno da Savia. Suas configurações gerais são somente para leitura.",
  ],
  "View users": ["Ver usuarios", "View users", "Ver usuários"],
  General: ["General", "General", "Geral"],
  Access: ["Acceso", "Access", "Acesso"],
  Configuration: ["Configuración", "Configuration", "Configuração"],
  "API keys": ["Claves API", "API keys", "Chaves API"],
  "Manage access links and sign-in providers.": [
    "Consulta el enlace de la organización y configura cómo inicia sesión tu equipo.",
    "Review the organization link and configure how your team signs in.",
    "Consulte o link da organização e configure como sua equipe faz login.",
  ],
  "Configure the tools available to this tenant.": [
    "Configura las herramientas disponibles para esta organización. Cada sección guarda sus cambios por separado.",
    "Configure the tools available to this organization. Each section saves its changes separately.",
    "Configure as ferramentas disponíveis para esta organização. Cada seção salva suas alterações separadamente.",
  ],
  "Delete tenant and all its data": [
    "Eliminar tenant y todos sus datos",
    "Delete tenant and all its data",
    "Excluir tenant e todos os seus dados",
  ],
  "Permanently removes this commercial tenant and its associated data. This action cannot be undone.":
    [
      "Elimina permanentemente este tenant comercial y sus datos asociados. Esta acción no se puede deshacer.",
      "Permanently removes this commercial tenant and its associated data. This action cannot be undone.",
      "Remove permanentemente este tenant comercial e os dados associados. Esta ação não pode ser desfeita.",
    ],
  "Type %{name} to confirm": [
    "Escribe %{name} para confirmar",
    "Type %{name} to confirm",
    "Digite %{name} para confirmar",
  ],
  "Delete permanently": [
    "Eliminar definitivamente",
    "Delete permanently",
    "Excluir permanentemente",
  ],
  "The tenant name changed or did not match. Refresh the tenant and confirm using its current name.":
    [
      "El nombre del tenant cambió o no coincide. Actualiza el tenant y confirma con su nombre actual.",
      "The tenant name changed or did not match. Refresh the tenant and confirm using its current name.",
      "O nome do tenant mudou ou não corresponde. Atualize o tenant e confirme usando o nome atual.",
    ],
  "An operation is in progress for this tenant. Wait for it to finish before retrying.":
    [
      "Hay una operación en curso para este tenant. Espera a que termine antes de reintentar.",
      "An operation is in progress for this tenant. Wait for it to finish before retrying.",
      "Há uma operação em andamento para este tenant. Aguarde até que ela termine antes de tentar novamente.",
    ],
  "A conflict interrupted the deletion. Refresh the tenant and try again.": [
    "Un conflicto interrumpió la eliminación. Actualiza el tenant y vuelve a intentarlo.",
    "A conflict interrupted the deletion. Refresh the tenant and try again.",
    "Um conflito interrompeu a exclusão. Atualize o tenant e tente novamente.",
  ],
  "Some cleanup services are unavailable. Refresh the tenant and retry the deletion.":
    [
      "Algunos servicios de limpieza no están disponibles. Actualiza el tenant e intenta eliminarlo de nuevo.",
      "Some cleanup services are unavailable. Refresh the tenant and retry the deletion.",
      "Alguns serviços de limpeza estão indisponíveis. Atualize o tenant e tente excluí-lo novamente.",
    ],
  "Tenant file cleanup failed. The tenant is inactive. Retry the deletion.": [
    "No se pudo completar la limpieza de archivos. El tenant quedó inactivo. Intenta eliminarlo de nuevo.",
    "Tenant file cleanup failed. The tenant is inactive. Retry the deletion.",
    "Não foi possível concluir a limpeza dos arquivos. O tenant ficou inativo. Tente excluí-lo novamente.",
  ],
  "Savia Request cleanup failed. The tenant is inactive. Retry the deletion.": [
    "No se pudo completar la limpieza de Savia Request. El tenant quedó inactivo. Intenta eliminarlo de nuevo.",
    "Savia Request cleanup failed. The tenant is inactive. Retry the deletion.",
    "Não foi possível concluir a limpeza do Savia Request. O tenant ficou inativo. Tente excluí-lo novamente.",
  ],
  "Tenant authentication settings could not be removed. The tenant is inactive. Retry the deletion.":
    [
      "No se pudo eliminar la configuración de autenticación. El tenant quedó inactivo. Intenta eliminarlo de nuevo.",
      "Tenant authentication settings could not be removed. The tenant is inactive. Retry the deletion.",
      "Não foi possível excluir as configurações de autenticação. O tenant ficou inativo. Tente excluí-lo novamente.",
    ],
  "A tenant image is still uploading. Wait for it to finish before retrying deletion.":
    [
      "Hay una imagen del tenant que se está subiendo. Espera a que termine y vuelve a intentar la eliminación.",
      "A tenant image is still uploading. Wait for it to finish before retrying deletion.",
      "Uma imagem do tenant ainda está sendo enviada. Aguarde o envio terminar antes de tentar excluir novamente.",
    ],
  "Deleting…": ["Eliminando…", "Deleting…", "Excluindo…"],
  "Deletion did not return a result. Refresh the tenant list to check its status before retrying.":
    [
      "No se recibió el resultado de la eliminación. Actualiza la lista de tenants para comprobar su estado antes de reintentar.",
      "Deletion did not return a result. Refresh the tenant list to check its status before retrying.",
      "A exclusão não retornou um resultado. Atualize a lista de tenants para verificar o status antes de tentar novamente.",
    ],
  "Could not delete the tenant. Retry or contact a platform administrator.": [
    "No se pudo eliminar el tenant. Inténtalo de nuevo o contacta a un administrador de plataforma.",
    "Could not delete the tenant. Retry or contact a platform administrator.",
    "Não foi possível excluir o tenant. Tente novamente ou entre em contato com um administrador da plataforma.",
  ],
  "This tenant no longer exists. Return to the tenant list and refresh it.": [
    "Este tenant ya no existe. Vuelve al listado de tenants y actualízalo.",
    "This tenant no longer exists. Return to the tenant list and refresh it.",
    "Este tenant não existe mais. Volte à lista de tenants e atualize-a.",
  ],
} satisfies MessageCatalog;
