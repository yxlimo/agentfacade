import { create } from '@bufbuild/protobuf'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import {
  DeletePublishedModelRequestSchema,
  ListPublishedModelsRequestSchema,
  PublishedModelSchema,
  SavePublishedModelRequestSchema,
  type PublishedModel,
} from '@/gen/agentfacade/admin/v1/admin_pb'
import { useAdminClient } from '@/features/auth/client-provider'
import { assertOk, describeErrorText } from '@/lib/errors'
import { queryKeys } from '@/lib/query-keys'
import { invalidateServerData } from '@/lib/server-data'
import i18n from '@/lib/i18n'

export function usePublishedModels() {
  const client = useAdminClient()
  return useQuery({
    queryKey: queryKeys.publishedModels.all,
    queryFn: () =>
      client.listPublishedModels(create(ListPublishedModelsRequestSchema)),
  })
}

/**
 * 保存一个主路由模型。model.id 必填：新建时先起一个对外的 id，保存的是那一条（同 id 覆盖）。
 *
 * 失败是一次 Connect 错误（这一族方法没有 ok / message 两格），页面拿到的是
 * reject，不会把失败当成功报出去。
 */
export function useSavePublishedModel() {
  const client = useAdminClient()
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (input: PublishedModel) => {
      return await client.savePublishedModel(
        create(SavePublishedModelRequestSchema, {
          model: create(PublishedModelSchema, input),
        })
      )
    },
    onError: (error) => {
      toast.error(describeErrorText(error, i18n.t))
    },
    onSuccess: () => {
      toast.success(i18n.t('models.saved'))
    },
    onSettled: () => {
      // 主路由模型是一份答复：发布与改都是那一份里的东西。
      invalidateServerData(queryClient, 'publishedModels')
    },
  })
}

/** 删掉一个主路由模型。 */
export function useDeletePublishedModel() {
  const client = useAdminClient()
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (input: { id: string }) => {
      const result = await client.deletePublishedModel(
        create(DeletePublishedModelRequestSchema, { id: input.id })
      )
      assertOk(result, i18n.t('models.deleteFailed'))
      return result
    },
    onError: (error) => {
      toast.error(describeErrorText(error, i18n.t))
    },
    onSuccess: (result) => {
      toast.success(result.message || i18n.t('models.deleted'))
    },
    onSettled: () => {
      // 主路由模型是一份答复：发布与改都是那一份里的东西。
      invalidateServerData(queryClient, 'publishedModels')
    },
  })
}
