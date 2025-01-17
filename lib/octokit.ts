import { createAppAuth } from "@octokit/auth-app";
import { Webhooks } from "@octokit/webhooks";
import {
  ActionItem,
  Channel,
  GithubItem,
  GithubItemType,
  Repository,
  SlackMessage,
  User,
} from "@prisma/client";
import { Octokit } from "octokit";
import { slack } from "..";
import prisma from "./db";
import { indexDocument } from "./elastic";
import metrics from "./metrics";
import { GithubData, SingleIssueOrPullData } from "./types";
import { MAINTAINERS, getMaintainers, getProjectName } from "./utils";

const appId = process.env.GITHUB_APP_ID || "";
const base64 = process.env.GITHUB_PRIVATE_KEY || "";
const privateKey = Buffer.from(base64, "base64").toString("utf-8");

export const webhooks = new Webhooks({ secret: process.env.GITHUB_WEBHOOK_SECRET || "" });

webhooks.on("issues.opened", async ({ payload }) => createGithubItem(payload));
webhooks.on("pull_request.opened", async ({ payload }) => createGithubItem(payload));
webhooks.on("pull_request.review_requested", async ({ payload }) => {
  metrics.increment("octokit.pull_request.review_requested");

  const { pull_request, repository, sender } = payload;
  const project = getProjectName({ repoUrl: repository.html_url });
  if (!project) return;

  for (let i = 0; i < pull_request.requested_reviewers.length; i++) {
    const user =
      MAINTAINERS.find(
        (maintainer) => maintainer.github === (pull_request.requested_reviewers[i] as any)?.login
      )?.slack ||
      (
        await prisma.user.findFirst({
          where: { githubUsername: (pull_request.requested_reviewers[i] as any)?.login },
        })
      )?.slackId;

    if (user) {
      await slack.client.chat.postMessage({
        channel: user,
        text: `You have been requested to review a pull request on ${project} by ${sender.login}.\n${pull_request.html_url}`,
      });
    } else {
      console.log("No user found for", pull_request.requested_reviewers[i]);
    }
  }
});

export const createGithubItem = async (payload) => {
  metrics.increment("octokit.create.item");
  console.log("🧶🧶 Running github webhook 🧶🧶");
  const { issue, pull_request, repository } = payload;
  const item = issue || pull_request;

  const project = getProjectName({ repoUrl: repository.html_url });
  if (!project) return;

  const dbRepo = await prisma.repository.upsert({
    where: { url: repository.html_url },
    create: { name: repository.name, owner: repository.owner.login, url: repository.html_url },
    update: { name: repository.name, owner: repository.owner.login },
  });

  const maintainers = getMaintainers({ repoUrl: repository.html_url });
  if (maintainers.find((maintainer) => maintainer?.github === item.user.login)) return;

  // find user by login
  const user = await prisma.user.findFirst({
    where: { githubUsername: item.user.login },
  });
  let author: User;

  if (!user)
    author = await prisma.user.create({
      data: { githubUsername: item.user.login },
    });
  else author = user;

  const actionItem = await prisma.actionItem.findFirst({
    where: { githubItem: { nodeId: item.node_id } },
  });

  const githubItem = await prisma.githubItem.upsert({
    where: { nodeId: item.node_id },
    create: {
      author: { connect: { id: author.id } },
      repository: { connect: { id: dbRepo.id } },
      nodeId: item.node_id,
      title: item.title,
      body: item.body || "",
      number: item.number,
      state: "open",
      type: item.node_id.startsWith("I_") ? GithubItemType.issue : GithubItemType.pull_request,
      createdAt: item.created_at,
      updatedAt: item.updated_at,
      actionItem: { create: { status: "open", totalReplies: 0 } },
      labelsOnItems: {
        create: item.labels?.map(({ name }) => ({
          label: { connectOrCreate: { where: { name }, create: { name } } },
        })),
      },
    },
    update: {
      state: "open",
      title: item.title,
      body: item.body || "",
      updatedAt: item.updated_at,
      labelsOnItems: {
        deleteMany: {},
        create: item.labels?.map(({ name }) => ({
          label: { connectOrCreate: { where: { name }, create: { name } } },
        })),
      },
      actionItem: {
        update: {
          status: actionItem?.resolvedAt ? "closed" : "open",
          participants: { deleteMany: {} },
        },
      },
    },
    include: { actionItem: true },
  });

  indexDocument(githubItem.actionItem!.id);
  console.log("🧶🧶 GitHub webhook syncing done 🧶🧶");
};

export const getOctokitToken = async (owner: string, repo: string) => {
  metrics.increment("octokit.get.token");

  if (!owner || !repo) return "";

  const auth = createAppAuth({
    appId,
    privateKey,
    clientId: process.env.GITHUB_CLIENT_ID,
    clientSecret: process.env.GITHUB_CLIENT_SECRET,
  });

  const appAuth = await auth({ type: "app" });
  const octokit = new Octokit();

  const installation = await octokit.rest.apps.getRepoInstallation({
    owner,
    repo,
    headers: { authorization: "Bearer " + appAuth.token },
  });

  const res = await octokit.rest.apps.createInstallationAccessToken({
    installation_id: installation.data.id,
    headers: { authorization: "Bearer " + appAuth.token },
  });

  return res.data.token;
};

export const getDisplayName = async ({
  owner,
  name,
  slackId,
  github,
}: {
  owner: string;
  name: string;
  slackId?: string;
  github?: string;
}) => {
  metrics.increment("octokit.get.display_name");

  const token = await getOctokitToken(owner, name);
  const octokit = new Octokit({ auth: "Bearer " + token });
  const maintainer = MAINTAINERS.find(
    (maintainer) => maintainer.github === github || maintainer.slack === slackId
  );

  const displayName = maintainer
    ? maintainer.id
    : slackId
    ? await slack.client.users
        .info({ user: slackId })
        .then(
          (res) => res.user?.name || res.user?.real_name || res.user?.profile?.display_name || ""
        )
    : await octokit.rest.users
        .getByUsername({ username: github ?? "" })
        .then((res) => res.data.name || "");

  return displayName;
};

export const listGithubItems = async (owner: string, name: string) => {
  metrics.increment("octokit.get.list_items");
  const query = `
    query ($owner: String!, $name: String!) {
      repository(owner: $owner, name: $name) {
        issues(first: 100, states: OPEN) {
          nodes {
            id
            number
            title
            bodyText
            createdAt
            updatedAt
            author {
              login
            }
            assignees(first: 5) {
              nodes {
                login
                createdAt
              }
            }
            labels(first:10) {
              nodes {
                name
              }
            }
            participants (first: 100) {
              nodes {
                login
              }
            }
            comments(first: 100) {
              totalCount
              nodes {
                author {
                  login
                }
                createdAt
              }
            }
          }
        }

        pullRequests(first: 100, states: OPEN) {
          nodes {
            id
            number
            title
            bodyText
            createdAt
            updatedAt
            author {
              login
            }
            assignees(first: 5) {
              nodes {
                login
                createdAt
              }
            }
            labels(first:10) {
              nodes {
                name
              }
            }
            participants (first: 100) {
              nodes {
                login
              }
            }
            comments(first: 100) {
              nodes {
                author {
                  login
                }
                createdAt
              }
            }
          }
        }
      }
    }
  `;

  const token = await getOctokitToken(owner, name);
  const octokit = new Octokit({ auth: "Bearer " + token });

  const res = (await octokit.graphql(query, { owner, name })) as GithubData;

  const items = [...res.repository.issues.nodes, ...res.repository.pullRequests.nodes];
  return items;
};

export const getGithubItem = async (owner: string, name: string, id: string) => {
  metrics.increment("octokit.get.item");

  const query = `
    query ($id: ID!) {
      node(id: $id) {
        ... on Issue {
          id
          number
          title
          bodyText
          closedAt
          assignees(first: 5) {
            nodes {
              login
              createdAt
            }
          }
          labels(first:10) {
            nodes {
              name
            }
          }
          participants(first: 100) {
            nodes {
              login
            }
          }
          comments(first: 100) {
            totalCount
            nodes {
              author {
                login
              }
              createdAt
            }
          }
        }
        ... on PullRequest {
          id
          number
          title
          bodyText
          closedAt
          assignees(first: 5) {
            nodes {
              login
              createdAt
            }
          }
          labels(first:10) {
            nodes {
              name
            }
          }
          participants(first: 100) {
            nodes {
              login
            }
          }
          comments(first: 100) {
            totalCount
            nodes {
              author {
                login
              }
              createdAt
            }
          }
        }
      }
    }
`;

  const token = await getOctokitToken(owner, name);
  const octokit = new Octokit({ auth: "Bearer " + token });
  const res = (await octokit.graphql(query, { id })) as SingleIssueOrPullData;
  return res;
};

export const assignIssueToVolunteer = async (
  items: (ActionItem & {
    slackMessage: (SlackMessage & { channel: Channel | null; author: User | null }) | null;
    githubItem: (GithubItem & { repository: Repository | null; author: User | null }) | null;
    assignee: User | null;
  })[],
  user: User,
  client: typeof slack.client,
  user_id: string,
  channel_id: string
) => {
  if (!user.githubToken || !user.githubUsername) {
    return await client.chat.postEphemeral({
      user: user_id,
      channel: channel_id,
      text: `You need to connect your GitHub account first. Please go to <${process.env.DEPLOY_URL}/auth?id=${user_id}|this link> to connect your GitHub account.`,
    });
  }

  const volunteeringAt = await prisma.volunteerDetail.findFirst({
    where: { assignee: { id: user.id } },
    include: {
      issue: { select: { repository: { select: { owner: true, name: true } }, number: true } },
    },
  });

  if (volunteeringAt) {
    return await client.chat.postEphemeral({
      user: user_id,
      channel: channel_id,
      text:
        "You can only volunteer for one issue at a time. Please finish your current issue first:\n\nhttps://github.com/" +
        volunteeringAt.issue?.repository?.owner +
        "/" +
        volunteeringAt.issue?.repository?.name +
        "/issues/" +
        volunteeringAt.issue?.number,
    });
  }

  try {
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      if (!item.githubItem) continue;

      const octokit = new Octokit({
        auth:
          "Bearer " +
          (await getOctokitToken(
            item.githubItem.repository?.owner || "",
            item.githubItem.repository?.name || ""
          )),
      });

      const issue = await octokit.rest.issues.get({
        owner: item.githubItem.repository?.owner || "",
        repo: item.githubItem.repository?.name || "",
        issue_number: item.githubItem.number,
      });

      if (issue.data.assignees && issue.data.assignees.length > 0) continue;
      const userOctokit = new Octokit({ auth: "Bearer " + user.githubToken });

      await userOctokit.rest.issues.createComment({
        owner: item.githubItem.repository?.owner || "",
        repo: item.githubItem.repository?.name || "",
        issue_number: item.githubItem.number,
        body: `I'm volunteering to work on this issue.`,
        headers: { authorization: "Bearer " + user.githubToken },
      });

      await octokit.rest.issues.addAssignees({
        owner: item.githubItem.repository?.owner || "",
        repo: item.githubItem.repository?.name || "",
        issue_number: item.githubItem.number,
        assignees: [user.githubUsername],
      });
      break;
    }

    await prisma.volunteerDetail.create({
      data: {
        assignee: { connect: { id: user.id } },
        assignedOn: new Date(),
        issue: { connect: { id: items[0].githubItem?.id } },
      },
    });

    await client.chat.postMessage({
      channel: user_id,
      text: `You have been assigned to issue #${items[0].githubItem?.number} on <${items[0].githubItem?.repository?.url}|${items[0].githubItem?.repository?.name}>.\n\nhttps://github.com/${items[0].githubItem?.repository?.owner}/${items[0].githubItem?.repository?.name}/issues/${items[0].githubItem?.number}`,
    });
  } catch (e) {
    console.log(e);
  }
};
