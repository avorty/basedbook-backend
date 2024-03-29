import { HttpException, HttpStatus, Injectable } from '@nestjs/common';
import { DbService } from '../db/db.service';
import { InsertPostDto } from './dto/insertPost.dto';
import { UpdatePostDto } from './dto/updatePost.dto';
import { filterProfanity } from '../lib/profanity_filter/profanity_filter';
import { JwtAuthDto } from '../auth/dto/jwt-auth.dto';

@Injectable()
export class SpottedService {
  constructor(private readonly prisma: DbService) {}

  async getPostList(
    userId: number | undefined,
    postSkip = 0,
    postTake = 999,
    commentSkip = 999,
    commentTake = 999,
    maxRepliesNesting = 2,
  ): Promise<any[]> {
    const { prisma } = this;

    const spottedPosts = await prisma.spottedPost.findMany({
      skip: postSkip,
      take: postTake,
      orderBy: {
        createdAt: 'desc',
      },
      select: {
        id: true,
        createdAt: true,
        title: true,
        text: true,
        isAnonymous: true,
        author: {
          select: {
            id: true,
            username: true,
          },
        },
        Comment: {
          skip: commentSkip,
          take: commentTake,
          orderBy: {
            parentId: 'asc',
          },
        },
        SpottedLikes: true,
        _count: {
          select: {
            Comment: true,
          },
        },
      },
    });
    spottedPosts.map((post: any) => {
      post.isOwned = post.author.id === userId;
      if (post.isAnonymous) delete post.author;

      post.likes = post.SpottedLikes.length;
      post.isLiked = post.SpottedLikes.some(
        (like: any) => like.userId === userId,
      );
      post.comments = post._count.Comment || 0;
      delete post._count;
      delete post.Comment;
      return post;
    });
    return spottedPosts;
  }

  private nestReplies(
    comments: any[],
    parentId?: number,
    nestingLeft?: number,
  ): any[] | null {
    if (nestingLeft && nestingLeft-- === 0) return null;

    let processingComments: any[];
    if (!parentId) {
      processingComments = comments.filter((comment) => !comment.parentId);
    } else {
      processingComments = comments.filter(
        (comment) => comment.parentId === parentId,
      );
    }
    const answer: any[] = [];

    processingComments.forEach((processingElement) =>
      comments.splice(
        comments.findIndex((e: any) => e === processingElement),
        1,
      ),
    );

    processingComments.forEach((processingElement) => {
      const nestedReplies = this.nestReplies(comments, processingElement.id);
      const modifiedElement = { ...processingElement, replies: nestedReplies };
      answer.push(modifiedElement);
    });

    if (answer.length === 0) return null;
    return answer;
  }
  addIsOwnedAttribute(comments: any[], userId: number) {
    const newComments: any[] = [];
    comments.map((comment) => {
      comment.isOwned = comment.authorId === userId;
      if (comment.replies && comment.replies.length > 0) {
        comment.replies = this.addIsOwnedAttribute(comment.replies, userId);
      }
      newComments.push(comment);
    });
    return newComments;
  }

  async getPostsCount() {
    return await this.prisma.spottedPost.count();
  }
  async getUsersPosts(skip: number, take: number, userId: number) {
    const spottedPosts = await this.prisma.spottedPost.findMany({
      select: {
        id: true,
        createdAt: true,
        title: true,
        text: true,
        author: {
          select: {
            id: true,
            username: true,
          },
        },
        Comment: {
          skip: 0,
          take: 1000,
          orderBy: {
            parentId: 'asc',
          },
        },
        SpottedLikes: true,
        _count: {
          select: {
            Comment: true,
          },
        },
      },
      where: {
        isAnonymous: false,
        authorId: userId,
      },
      orderBy: [
        {
          createdAt: 'desc',
        },
      ],
      skip,
      take,
    });
    spottedPosts.map((post: any) => {
      post.isLiked = post.SpottedLikes.some(
        (like: { userId: number }) => like.userId === userId,
      );
      post.likes = post.SpottedLikes.length;
      post.comments = post._count.Comment || 0;
      delete post.Comment;
      delete post.SpottedLikes;
      delete post._count;
      return post;
    });
    return spottedPosts;
  }

  async getPostById(postId: number, userId: number | undefined): Promise<any> {
    const spottedPost: { [key: string]: any } =
      await this.prisma.spottedPost.findUniqueOrThrow({
        where: {
          id: postId,
        },
        select: {
          id: true,
          createdAt: true,
          title: true,
          text: true,
          author: {
            select: {
              id: true,
              username: true,
            },
          },
          isAnonymous: true,
          _count: {
            select: { SpottedLikes: true, Comment: true },
          },
          SpottedLikes: {
            select: { userId: true },
          },
          Comment: {
            orderBy: {
              parentId: 'asc',
            },
            select: {
              id: true,
              text: true,
              user: {
                select: {
                  id: true,
                  username: true,
                },
              },
              authorId: true,
              parentId: true,
            },
          },
        },
      });
    spottedPost.likes = spottedPost._count.SpottedLikes;
    spottedPost.isLiked = spottedPost.SpottedLikes.some(
      (like: { userId: number }) => like.userId === userId,
    );
    spottedPost.isOwned = spottedPost.author.id === userId;
    spottedPost.comments = this.nestReplies(
      spottedPost.Comment,
      undefined,
      1000,
    );
    if (userId && spottedPost.comments) {
      this.addIsOwnedAttribute(spottedPost.comments, userId);
    }
    delete spottedPost._count;
    delete spottedPost.SpottedLikes;
    delete spottedPost.Comment;
    return spottedPost;
  }

  async insertNewPost(postData: InsertPostDto, authorId: number) {
    postData.text = filterProfanity(postData.text);
    await this.prisma.spottedPost.create({
      data: Object.assign(postData, { authorId }),
    });
  }

  async changePostById(
    newPostData: UpdatePostDto | { id?: number },
    userId: number,
    roles?: typeof JwtAuthDto.prototype.roles,
  ) {
    const { id } = newPostData;
    delete newPostData.id;
    if (roles?.includes('MODERATOR'))
      await this.prisma.spottedPost.updateMany({
        data: newPostData,
        where: { id },
      });
    await this.prisma.spottedPost.updateMany({
      data: newPostData,
      where: { id, authorId: userId },
    });
  }

  async deletePostById(
    id: number,
    userId: number,
    roles?: typeof JwtAuthDto.prototype.roles,
  ) {
    if (roles?.includes('MODERATOR'))
      await this.prisma.spottedPost.deleteMany({ where: { id } });
    await this.prisma.spottedPost.deleteMany({
      where: { id, authorId: userId },
    });
  }

  async giveALike(postId: number, userId: number) {
    await this.prisma.spottedLikes
      .create({ data: { postId, userId } })
      .catch((err) => {
        console.error(err);
        throw new HttpException(
          `CONFLICT: user nr. ${userId} already liked post with id: ${postId}`,
          HttpStatus.CONFLICT,
        );
      });
  }

  async removeLike(postId: number, userId: number) {
    await this.prisma.spottedLikes.deleteMany({
      where: { postId, userId },
    });
  }

  async report(
    postId: number,
    userId: number,
    reason: string,
  ): Promise<object> {
    await this.prisma.report.create({
      data: {
        userId,
        spottedPostId: postId,
        reason,
      },
    });
    return { msg: 'Successfully reported the post' };
  }
}
