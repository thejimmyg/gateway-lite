# AWS

Here's a tutorial for setting up everything you need to get Gateway Lite deployed on EC2.

## Configure the AWS CLI

See also: [https://docs.aws.amazon.com/cli/latest/userguide/cli-configure-envvars.html](https://docs.aws.amazon.com/cli/latest/userguide/cli-configure-envvars.html)

We'll use environment variables to configure everything. Note that setting one of these environment variables overrides any data in `.aws`. Only explicit command line flags can override the environment variables.

To get your credentials, go to the AWS web console and go to IAM -> Users -> Select yourself -> Security Credentials tab -> Create Access Key.

When using bash, these variables will be available only in your current terminal:

```
# Essentially a username, replace XXX with your access key from the AWS web console
export AWS_ACCESS_KEY_ID=XXX
# Essentially a password, replace with your secret access key from the AWS web console
export AWS_SECRET_ACCESS_KEY=XXX
# Below eu-west-1 is Ireland. If you choose a different region, you'll also need to find the correct `--image-id` option for the `run-instances` command later in these instructions.
export AWS_DEFAULT_REGION=eu-west-1
export AWS_DEFAULT_OUTPUT=json
```

## Provision a Server

Now for the main instructions, this should be copy and paste-able:

```
# Install the AWS CLI
# https://docs.aws.amazon.com/cli/latest/userguide/cli-chap-install.html
brew install awscli

# Verify that you can connect to AWS
aws ec2 describe-regions --output text

# The `aws` command supports querying of the output with the `--query` option. We'll use it quite a lot here to extract the bits we need from the command output
export GROUP_ID=`aws ec2 create-security-group --group-name devenv-sg --description "security group for development environment" --output text`
echo "Created new security group ${GROUP_ID}"
# Allow incoming SSH 22, HTTP 80 and HTTPS 443 from any IP
aws ec2 authorize-security-group-ingress --group-name devenv-sg --protocol tcp --port 22 --cidr 0.0.0.0/0
aws ec2 authorize-security-group-ingress --group-name devenv-sg --protocol tcp --port 80 --cidr 0.0.0.0/0
aws ec2 authorize-security-group-ingress --group-name devenv-sg --protocol tcp --port 443 --cidr 0.0.0.0/0
# Create a key pair which will allow you to SSH into the server you create
# CAUTION: If you lose the `devenv-key.pem` file you are about to create you can't get it again, you won't be able to log into any servers created with it.
aws ec2 create-key-pair --key-name devenv-key --query 'KeyMaterial' --output text > devenv-key.pem
# Make it secure
chmod 400 devenv-key.pem

export INSTANCE_ID=`aws ec2 run-instances --image-id ami-09f0b8b3e41191524 --security-group-ids "${GROUP_ID}" --count 1 --instance-type t2.micro --key-name devenv-key --query 'Instances[0].InstanceId' --output text`
echo "Your instance ID is ${INSTANCE_ID}."

# EC2_PUBLIC_IP set next is a public, static IP you will always be able to use to access your instance (even after restarts) but it will be lost if you terminate the instance
export EC2_PUBLIC_IP=`aws ec2 describe-instances --instance-ids "$INSTANCE_ID" --query 'Reservations[0].Instances[0].PublicIpAddress' --output=text`
echo "Your instance is will be online at ${EC2_PUBLIC_IP} in a minute or two."
```

Now set up your DNS A records. Make it so that www.${DOMAIN} and ${DOMAIN} both have `A` records pointing to ${EC2_PUBLIC_IP}.

If you've recently used the domain, you may need to wait until its expiry time for the internet to notice the change.

XXX Add instructions for this.

You can now log in with:

```
ssh -i devenv-key.pem ubuntu@$EC2_PUBLIC_IP
```

**NOTE: The `ubuntu` user you signed in with above has `sudo` access without a password.**

You may have to run this if you get a warning:

```
sudo locale-gen en_GB.UTF-8
```

Add swap space so that your instance shouldn't run out of memory. This works by creating an area on your hard drive and using it for extra memory, this memory is much slower than normal memory however much more of it is available.

To add this extra space to your instance you type:

```
sudo /bin/dd if=/dev/zero of=/var/swap.1 bs=1M count=1024
sudo chmod 600 /var/swap.1
sudo /sbin/mkswap /var/swap.1
sudo /sbin/swapon /var/swap.1
```

If you need more than 1024 then change that to something higher.

To enable it by default after reboot, add this line to /etc/fstab:

```
/var/swap.1   swap    swap    defaults        0   0
```

**Caution: When using Docker you need to keep an eye on memory usage, sometimes Docker can use all the memory on the system which can prevent SSH from working. If you find this happens, upgrade the memory on the machine or add more swap space.**

## Docker Compose

Once you have safely SSHed into the server, you can set about installing Docker and Docker Compose from the server's terminal.

Install docker from the official Docker repositories (not from the slightly less up-to-date Ubuntu ones):

```
sudo apt update -y
sudo apt upgrade -y
sudo apt install -y apt-transport-https ca-certificates curl software-properties-common
# Trust Docker, add their GPG key to apt so we can use their repo.
curl -fsSL https://download.docker.com/linux/ubuntu/gpg | sudo apt-key add -
sudo add-apt-repository "deb [arch=amd64] https://download.docker.com/linux/ubuntu bionic stable"
sudo apt update -y
```

Now check the candidate for Docker comes from the `download.docker.com` repo
and install it:

```
# You should see the `Version Table` list download.docker.com as the source for `docker-ce`:
apt-cache policy docker-ce
# Install `docker-ce`
sudo apt install -y docker-ce
sudo systemctl status docker
```

Don't require sudo with docker:

```
sudo usermod -aG docker ${USER}
sudo su - ${USER}
# Check that `docker` appears below:
id -nG | grep docker
docker ps
```

Now install docker compose:

```
sudo curl -L https://github.com/docker/compose/releases/download/1.23.2/docker-compose-`uname -s`-`uname -m` -o /usr/local/bin/docker-compose
sudo chmod +x /usr/local/bin/docker-compose
docker-compose --version
```

Now you can follow the instructions in the
[README.md](https://github.com/thejimmyg/gateway-lite) for writing a Docker
Compose file, creating the directory structures required and running a server.

When you are done, exit the server.

Tip: If you ever encounter an error like this:

```
ERROR: for git  Cannot start service git: driver failed programming external connectivity on endpoint ubuntu_git_1 (cb946a390de6d36b20676b1e5c7964aba2683a3f992380488023417db4473dbd): Bind for 0.0.0.0:8022 failed: port is already allocated
ERROR: Encountered errors while bringing up the project.
```

You can often fix it with `docker-compose stop; sudo service docker restart; docker-compose up --force-recreate`

Also, worth knowing is this command:

```
docker system prune --volumes --all
```

If your docker containers are all running, the above command will delete
everything not already in use. Use with care!


## SMTP (SES)

Back on the machine you used to provision a VM and with the same environment variables in place, you can following instructions to enable an SMTP for sending email.

SES isn't available in London, so make sure you've chosen Ireland:

```
export AWS_DEFAULT_REGION=eu-west-1
```

To send email from SES you need to verify your email address or an entire
domain.

If you verify an entire domain, you can send emails from all that domain e.g.
user1@example.com, user2@example.com etc.

Instead, we'll just verify one identity:

```
export EMAIL_ADDRESS=user1@example.com
aws ses verify-email-identity --email-address "${EMAIL_ADDRESS}"
```

Now wait a few moments and check your email, click the link and follow the instructions to verify.

Create an IAM user to use for SMTP credentials:

```
aws iam create-user --user-name smtp
aws iam put-user-policy --user-name smtp --policy-name 'send-email' --policy-document '{ "Statement": [{"Effect":"Allow", "Action":"ses:SendRawEmail", "Resource":"*" }]}'
export CREDS=`aws iam create-access-key --user-name smtp --query "AccessKey.{AccessKeyId:AccessKeyId,SecretAccessKey:SecretAccessKey}" --output=text`
export SMTP_USERNAME=`echo "$CREDS" | awk '{print $1}'`
export SECRET_ACCESS_KEY_FOR_SMTP=`echo "$CREDS" | awk '{print $2}'`
export SMTP_PASSWORD=`(echo -en "\x02"; echo -n 'SendRawEmail' \
  | openssl dgst -sha256 -hmac $SECRET_ACCESS_KEY_FOR_SMTP -binary) \
  | openssl enc -base64`
echo "Username: $SMTP_USERNAME Password: $SMTP_PASSWORD"
```

You can now send an email using SMTP.

**Caution: Make sure you use your *SMTP* credentials and not your AWS credentials, and make sure you use a secure TLS transport.**

Here's an example of using an SMTP server with these credentials from node.

First install `nodemailer`:

```
npm install nodemailer
```

Then create this `send.js` script with the correct credentials:

```
cat << EOF > send.js
const nodemailer = require('nodemailer')

const poolConfig = {
    pool: false,
    host: 'email-smtp.${AWS_DEFAULT_REGION}.amazonaws.com',
    port: 465,
    secure: true, // use TLS
    auth: {
        user: '$SMTP_USERNAME',
        pass: '$SMTP_PASSWORD'
    }
}

const transporter = nodemailer.createTransport(poolConfig)

// verify connection configuration
transporter.verify(function(error, success) {
   if (error) {
        console.log(error);
   } else {
        console.log('Server is ready to take our messages');
   }
});

const message = {
    from: '$EMAIL_ADDRESS',
    to: '$EMAIL_ADDRESS',
    subject: 'Test Message',
    text: 'Plaintext version of the message',
    html: '<p>HTML version of the message</p>'
};


transporter.sendMail(message, (err, info) => {
  if (err) {
    console.error(err)
  } else {
     console.info(info)
  }
})
EOF
```

Check the credentials and SMTP server address are set up correctly then test it out like this:

```
node send.js
```

## Cleaning up

Here are some commands that will help you clean up everything that you've just created.

**CAUTION: Make sure you understand what these commands to before running them.**

```
aws ec2 terminate-instances --instance-ids "$INSTANCE_ID" --query "TerminatingInstances[0].CurrentState.Name" --output=text
```

You have to wait for the instance to stop before continuing, but you can run the command above multiple times safely until you see `terminated`.

Then continue with:

```
aws ec2 delete-security-group --group-name devenv-sg  --output text
aws ec2 delete-key-pair --key-name devenv-key --output text
rm -f devenv-key.pem
aws ses delete-identity --identity "$EMAIL_ADDRESS"
aws iam delete-user-policy --user-name smtp --policy-name 'send-email'
aws iam delete-access-key --user-name smtp --access-key-id "$SMTP_USERNAME"
aws iam delete-user --user-name smtp
```
